//! unpack sword1 (新剑侠情缘) PACKAGE .pak archives.
//!
//! format (ref: Upwinded/JXQY-all-in-one src/File/PakFile.cpp, verified against
//! games-raw/xinjianxiaqingyuan/data/*.pak):
//!   header: "PACKAGE\0" + fileCount(u32 LE) + compressType(u32 LE)
//!   index:  fileCount x { fileId(u32) offset(u32) uncompressedSize(u32) },
//!           sorted by fileId, no name table; compressed span of entry i =
//!           offset[i+1] - offset[i] (last: file end - offset)
//!   data:   per file, split into 64KB blocks; blockCount x u16 compressed
//!           block sizes first (0 = stored), then block data (LZO1X when
//!           compressType == 2)
//!
//! file names are not stored, only their hash; pass --names <file> (one
//! candidate path per line, UTF-8) to recover names by hash matching.
//! unmatched entries land in _unnamed/<hash>.<ext>.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

const BLOCK_SIZE: usize = 0x10000;

/// port of PakFile::hashFileName — operates on GBK bytes, lowercases ASCII,
/// '/' -> '\', and (crucially) reads bytes through signed char, so GBK high
/// bytes sign-extend to huge u32 values
fn hash_file_name(name: &str) -> u32 {
    let (gbk, _, _) = encoding_rs::GBK.encode(name);
    let mut result: u32 = 0;
    let mut cnt: u32 = 0;
    for &b in gbk.iter() {
        let mut c = b;
        if c == b'/' {
            c = b'\\';
        }
        if c.is_ascii_uppercase() {
            c += 0x20;
        }
        let u = (c as i8) as i32 as u32;
        result = u
            .wrapping_mul(cnt.wrapping_add(1))
            .wrapping_add(result)
            % 0x8000_000B;
        result = ((result ^ 0xFFFF_FFFF).wrapping_add(1) << 4).wrapping_sub(result);
        cnt += 1;
    }
    result ^ 0x1234_5678
}

struct Entry {
    id: u32,
    offset: u32,
    size: u32,
}

fn parse_index(data: &[u8]) -> Result<(u32, Vec<Entry>), String> {
    if data.len() < 16 || &data[..8] != b"PACKAGE\0" {
        return Err(format!("not a PACKAGE file: {:?}", &data[..data.len().min(8)]));
    }
    let count = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    let compress = u32::from_le_bytes(data[12..16].try_into().unwrap());
    if data.len() < 16 + count * 12 {
        return Err("truncated index".into());
    }
    let mut entries = Vec::with_capacity(count);
    for i in 0..count {
        let o = 16 + i * 12;
        entries.push(Entry {
            id: u32::from_le_bytes(data[o..o + 4].try_into().unwrap()),
            offset: u32::from_le_bytes(data[o + 4..o + 8].try_into().unwrap()),
            size: u32::from_le_bytes(data[o + 8..o + 12].try_into().unwrap()),
        });
    }
    Ok((compress, entries))
}

/// port of PakFile::unpak
fn unpak(blob: &[u8], out_len: usize, compress: u32) -> Result<Vec<u8>, String> {
    let block_count = out_len.div_ceil(BLOCK_SIZE);
    if block_count == 0 || block_count * 2 > blob.len() {
        return Err(format!(
            "bad block table: {} blocks, {} blob bytes",
            block_count,
            blob.len()
        ));
    }
    let mut sizes = Vec::with_capacity(block_count);
    let mut p = 0usize;
    for _ in 0..block_count {
        sizes.push(u16::from_le_bytes([blob[p], blob[p + 1]]) as usize);
        p += 2;
    }
    let mut out: Vec<u8> = Vec::with_capacity(out_len);
    let mut buf = vec![0u8; BLOCK_SIZE];
    for (i, &bsize) in sizes.iter().enumerate() {
        let want = out_len - out.len();
        if compress == 2 && bsize != 0 {
            if p + bsize > blob.len() {
                return Err("lzo block overruns blob".into());
            }
            let n = lzo::decompress_into(&blob[p..p + bsize], &mut buf)
                .map_err(|e| format!("lzo: {e:?}"))?;
            out.extend_from_slice(&buf[..n.min(want)]);
            p += bsize;
        } else {
            let stored = if bsize != 0 {
                bsize
            } else if i != block_count - 1 {
                BLOCK_SIZE
            } else if compress == 2 {
                blob.len() - p // raw remainder, may include slack
            } else {
                BLOCK_SIZE
            };
            if p + stored > blob.len() {
                return Err("stored block overruns blob".into());
            }
            out.extend_from_slice(&blob[p..p + stored.min(want)]);
            p += stored;
        }
    }
    if out.len() != out_len {
        return Err(format!("size mismatch: got {}, want {}", out.len(), out_len));
    }
    Ok(out)
}

fn sniff_ext(data: &[u8], default_ext: &str) -> &'static str {
    if data.starts_with(b"RIFF") {
        return "wav";
    }
    if data.starts_with(b"ID3") || data.starts_with(&[0xFF, 0xFB]) {
        return "mp3";
    }
    if data.starts_with(b"OggS") {
        return "ogg";
    }
    // leak-free enough for a cli: map known defaults to static strs
    match default_ext {
        "asf" => "asf",
        "mpc" => "mpc",
        "map" => "map",
        "ini" => "ini",
        "script" => "txt",
        "sound" => "wav",
        "img" => "img",
        "font" => "bin",
        _ => "bin",
    }
}

/// keep names inside out_dir: '\' -> '/', strip leading slashes and '..'
fn sanitize(name: &str) -> PathBuf {
    let mut p = PathBuf::new();
    for part in name.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        p.push(part);
    }
    p
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut positional: Vec<&str> = Vec::new();
    let mut name_files: Vec<&str> = Vec::new();
    let mut list_only = false;
    let mut hash_query: Option<&str> = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--names" => {
                i += 1;
                name_files.push(&args[i]);
            }
            "--list" => list_only = true,
            "--hash" => {
                i += 1;
                hash_query = Some(&args[i]);
            }
            other => positional.push(other),
        }
        i += 1;
    }

    if let Some(q) = hash_query {
        println!("{:#010x}  {}", hash_file_name(q), q);
        return;
    }
    if positional.len() < 1 || (!list_only && positional.len() < 2) {
        eprintln!("usage: unpack-pak <pak> <out_dir> [--names <file>]...");
        eprintln!("       unpack-pak <pak> --list");
        eprintln!("       unpack-pak --hash <name>");
        std::process::exit(1);
    }

    let pak_path = Path::new(positional[0]);
    let data = fs::read(pak_path).expect("read pak");
    let (compress, entries) = parse_index(&data).expect("parse index");
    let stem = pak_path.file_stem().unwrap().to_string_lossy().to_string();
    println!(
        "{}: {} entries, compressType={}",
        pak_path.display(),
        entries.len(),
        compress
    );

    if list_only {
        for e in &entries {
            println!("{:#010x}  off={:#010x}  size={}", e.id, e.offset, e.size);
        }
        return;
    }

    let mut names: HashMap<u32, String> = HashMap::new();
    for nf in &name_files {
        let text = fs::read_to_string(nf).expect("read names file");
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            names.insert(hash_file_name(line), line.to_string());
        }
    }

    let out_dir = Path::new(positional[1]);
    let mut ok = 0usize;
    let mut named = 0usize;
    let mut empty = 0usize;
    let mut errors = 0usize;
    for (i, e) in entries.iter().enumerate() {
        let end = if i + 1 < entries.len() {
            entries[i + 1].offset as usize
        } else {
            data.len()
        };
        let blob = &data[e.offset as usize..end];

        let content = if e.size == 0 {
            empty += 1;
            Vec::new()
        } else {
            match unpak(blob, e.size as usize, compress) {
                Ok(c) => c,
                Err(err) => {
                    eprintln!("  ERR {:#010x}: {}", e.id, err);
                    errors += 1;
                    continue;
                }
            }
        };

        let rel = match names.get(&e.id) {
            Some(n) => {
                named += 1;
                sanitize(n)
            }
            None => PathBuf::from("_unnamed")
                .join(&stem)
                .join(format!("{:08x}.{}", e.id, sniff_ext(&content, &stem))),
        };
        let out_path = out_dir.join(rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(&out_path, &content).expect("write file");
        ok += 1;
    }
    println!(
        "extracted {}/{} (named {}, empty {}, errors {})",
        ok,
        entries.len(),
        named,
        empty,
        errors
    );
}
