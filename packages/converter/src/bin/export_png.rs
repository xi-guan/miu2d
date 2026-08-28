//! ASF → PNG dumper for upscaler comparison experiments.
//!
//! usage: export-png <input.asf> <out-dir> [max-frames]
//!
//! Emits full-canvas (asf.width × asf.height) RGBA PNGs rather than the
//! tight-bbox crops MSF stores, so every frame stays anchor-aligned and an
//! upscaled set only needs a uniform scale factor applied to left/bottom.
//! Temporary tool — delete once the upscaling approach is settled.

use std::path::Path;

#[inline]
fn get_i32_le(data: &[u8], offset: usize) -> i32 {
    if offset + 4 > data.len() {
        return 0;
    }
    i32::from_le_bytes([
        data[offset],
        data[offset + 1],
        data[offset + 2],
        data[offset + 3],
    ])
}

fn decode_asf_rle_frame(
    data: &[u8],
    palette: &[[u8; 4]],
    offset: usize,
    length: usize,
    width: usize,
    height: usize,
    pixels: &mut [u8],
) {
    let data_end = offset + length;
    let max_pixels = width * height * 4;
    let mut data_offset = offset;
    let mut pixel_idx = 0usize;
    while data_offset < data_end && data_offset + 1 < data.len() && pixel_idx < max_pixels {
        let pixel_count = data[data_offset];
        let pixel_alpha = data[data_offset + 1];
        data_offset += 2;
        for _ in 0..pixel_count {
            if pixel_idx >= max_pixels {
                break;
            }
            if pixel_alpha == 0 {
                pixel_idx += 4;
            } else if data_offset < data.len() {
                let color_index = data[data_offset] as usize;
                data_offset += 1;
                if color_index < palette.len() {
                    pixels[pixel_idx] = palette[color_index][0];
                    pixels[pixel_idx + 1] = palette[color_index][1];
                    pixels[pixel_idx + 2] = palette[color_index][2];
                    pixels[pixel_idx + 3] = pixel_alpha;
                }
                pixel_idx += 4;
            }
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: export-png <input.asf> <out-dir> [max-frames]");
        std::process::exit(2);
    }
    let input = Path::new(&args[1]);
    let out_dir = Path::new(&args[2]);
    let max_frames: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(4);

    let asf_data = match std::fs::read(input) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("read {}: {e}", input.display());
            std::process::exit(1);
        }
    };
    if asf_data.len() < 80 || std::str::from_utf8(&asf_data[0..7]).ok() != Some("ASF 1.0") {
        eprintln!("{}: not an ASF 1.0 file", input.display());
        std::process::exit(1);
    }

    let mut offset = 16usize;
    let width = get_i32_le(&asf_data, offset) as usize;
    offset += 4;
    let height = get_i32_le(&asf_data, offset) as usize;
    offset += 4;
    let frame_count = get_i32_le(&asf_data, offset) as usize;
    offset += 4;
    let directions = get_i32_le(&asf_data, offset) as usize;
    offset += 4;
    let color_count = get_i32_le(&asf_data, offset) as usize;
    offset += 4;
    let interval = get_i32_le(&asf_data, offset);
    offset += 4;
    let left = get_i32_le(&asf_data, offset);
    offset += 4;
    let bottom = get_i32_le(&asf_data, offset);
    offset += 4;
    offset += 16; // reserved

    // file stores BGRA, engine wants RGBA
    let mut palette: Vec<[u8; 4]> = Vec::with_capacity(color_count);
    for _ in 0..color_count {
        if offset + 4 > asf_data.len() {
            break;
        }
        palette.push([asf_data[offset + 2], asf_data[offset + 1], asf_data[offset], 255]);
        offset += 4;
    }

    let mut frame_offsets = Vec::with_capacity(frame_count);
    let mut frame_lengths = Vec::with_capacity(frame_count);
    for _ in 0..frame_count {
        if offset + 8 > asf_data.len() {
            break;
        }
        frame_offsets.push(get_i32_le(&asf_data, offset) as usize);
        offset += 4;
        frame_lengths.push(get_i32_le(&asf_data, offset) as usize);
        offset += 4;
    }

    if let Err(e) = std::fs::create_dir_all(out_dir) {
        eprintln!("mkdir {}: {e}", out_dir.display());
        std::process::exit(1);
    }

    let stem = input.file_stem().unwrap_or_default().to_string_lossy();
    let n = frame_count.min(max_frames).min(frame_offsets.len());
    for i in 0..n {
        let mut pixels = vec![0u8; width * height * 4];
        decode_asf_rle_frame(
            &asf_data,
            &palette,
            frame_offsets[i],
            frame_lengths[i],
            width,
            height,
            &mut pixels,
        );
        let path = out_dir.join(format!("{stem}_f{i:02}.png"));
        let buf = match image::RgbaImage::from_raw(width as u32, height as u32, pixels) {
            Some(b) => b,
            None => {
                eprintln!("frame {i}: bad buffer size");
                continue;
            }
        };
        if let Err(e) = buf.save(&path) {
            eprintln!("save {}: {e}", path.display());
        }
    }

    println!(
        "{}: {width}x{height} frames={frame_count} dirs={directions} colors={color_count} interval={interval} left={left} bottom={bottom} -> wrote {n}",
        stem
    );
}
