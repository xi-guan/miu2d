//! brute-force the unknown prefix/suffix of a pak path around a known anchor.
//!
//! the pak index stores only hashFileName(path); when shape guessing fails,
//! enumerate short unknown segments (DFS over a charset, hash state shared
//! per prefix) and report any candidate whose hash lands in the index.
//!
//! usage:
//!   brute-hash <pak> --head <h> --tail <t> --maxlen N
//! candidate = head + M + tail, M enumerated over the charset up to maxlen;
//! fix as much of the name as possible (e.g. --tail ".mpc") to keep the
//! false-positive rate (nodes x entries / 2^32) below ~1

use rayon::prelude::*;
use std::env;
use std::fs;

const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789_-.\\: ";

#[derive(Clone, Copy)]
struct HashState {
    result: u32,
    cnt: u32,
}

impl HashState {
    fn new() -> Self {
        HashState { result: 0, cnt: 0 }
    }
    #[inline(always)]
    fn push(&mut self, b: u8) {
        let mut c = b;
        if c == b'/' {
            c = b'\\';
        }
        if c.is_ascii_uppercase() {
            c += 0x20;
        }
        let u = (c as i8) as i32 as u32;
        self.result = u
            .wrapping_mul(self.cnt.wrapping_add(1))
            .wrapping_add(self.result)
            % 0x8000_000B;
        self.result = ((self.result ^ 0xFFFF_FFFF).wrapping_add(1) << 4).wrapping_sub(self.result);
        self.cnt += 1;
    }
    fn push_all(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.push(b);
        }
    }
    fn value(&self) -> u32 {
        self.result ^ 0x1234_5678
    }
}

fn gbk_encode(s: &str) -> Vec<u8> {
    let (out, _, _) = encoding_rs::GBK.encode(s);
    out.into_owned()
}

fn read_index(pak: &str) -> Vec<u32> {
    let data = fs::read(pak).expect("read pak");
    assert_eq!(&data[..8], b"PACKAGE\0");
    let count = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
    let mut ids = Vec::with_capacity(count);
    for i in 0..count {
        let o = 16 + i * 12;
        ids.push(u32::from_le_bytes(data[o..o + 4].try_into().unwrap()));
    }
    ids.sort_unstable();
    ids
}

fn render(bytes: &[u8]) -> String {
    let (s, _) = encoding_rs::GBK.decode_without_bom_handling(bytes);
    s.into_owned()
}

// candidate = head(already in state) + M(buf) + tail; check at every node
fn dfs(state: HashState, buf: &mut Vec<u8>, depth: usize, tail: &[u8], index: &[u32], head: &str, tail_s: &str) {
    let mut full = state;
    full.push_all(tail);
    if index.binary_search(&full.value()).is_ok() {
        println!("HIT {:#010x}  {}[{}]{}", full.value(), head, render(buf), tail_s);
    }
    if depth == 0 {
        return;
    }
    for &c in CHARSET {
        let mut s2 = state;
        s2.push(c);
        buf.push(c);
        dfs(s2, buf, depth - 1, tail, index, head, tail_s);
        buf.pop();
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    let mut pak = None;
    let mut head = String::new();
    let mut tail = String::new();
    let mut maxlen = 4usize;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--head" => {
                i += 1;
                head = args[i].clone();
            }
            "--tail" => {
                i += 1;
                tail = args[i].clone();
            }
            "--maxlen" => {
                i += 1;
                maxlen = args[i].parse().unwrap();
            }
            other => pak = Some(other.to_string()),
        }
        i += 1;
    }
    let pak = pak.expect("pak path required");
    let index = read_index(&pak);
    let head_bytes = gbk_encode(&head);
    let tail_bytes = gbk_encode(&tail);
    eprintln!(
        "{}: {} entries; head={:?} tail={:?} maxlen={} charset={}",
        pak,
        index.len(),
        head,
        tail,
        maxlen,
        CHARSET.len()
    );

    let mut base = HashState::new();
    base.push_all(&head_bytes);
    // depth 0 (no middle segment)
    {
        let mut full = base;
        full.push_all(&tail_bytes);
        if index.binary_search(&full.value()).is_ok() {
            println!("HIT {:#010x}  {}[]{}", full.value(), head, tail);
        }
    }
    CHARSET.par_iter().for_each(|&c| {
        let mut s = base;
        s.push(c);
        let mut buf = vec![c];
        dfs(s, &mut buf, maxlen - 1, &tail_bytes, &index, &head, &tail);
    });
    eprintln!("done");
}
