//! SFX payload 读取：安装器 exe 尾部附加的 zip 数据定位与校验。
//!
//! 分发物布局（由 scripts/build-desktop-installer.mjs 拼接）：
//! ```text
//! [cargo 编译的安装器 exe] [payload.zip] [u64 LE: zip 长度] [8B 魔数 ACLAWSET]
//! ```
//! 读取时从自身文件末尾定位魔数与长度，再回读 zip 字节。裸 cargo 产物
//! （开发运行）没有尾部数据，`locate` 返回 `Ok(None)`，UI 展示开发提示。

use std::fs;
use std::path::PathBuf;

/// SFX 尾部魔数，8 字节。
pub const MAGIC: &[u8; 8] = b"ACLAWSET";
/// 尾部元数据长度：u64 长度 + 魔数。
const TAIL_LEN: u64 = 16;

#[derive(Debug)]
pub enum PayloadError {
    Io(std::io::Error),
    /// 文件尾部没有 SFX 魔数（裸 exe 或损坏）。
    NoPayload,
    /// 魔数存在但声明的长度越界（截断或拼接错误）。
    Corrupt,
}

impl std::fmt::Display for PayloadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PayloadError::Io(e) => write!(f, "读取安装器自身失败：{e}"),
            PayloadError::NoPayload => write!(f, "安装器缺少 payload（开发版 exe 或文件损坏）"),
            PayloadError::Corrupt => write!(f, "安装器 payload 元数据损坏（长度越界）"),
        }
    }
}

/// 定位到的 payload 元数据。
pub struct SelfPayload {
    /// zip 数据在 exe 文件中的起始偏移。
    pub offset: u64,
    /// zip 数据字节数。
    pub len: u64,
}

/// 当前 exe 的路径。测试可经 `CLAW_SETUP_SELF_EXE` 指向拼接产物。
pub fn self_exe_path() -> Result<PathBuf, std::io::Error> {
    if let Ok(path) = std::env::var("CLAW_SETUP_SELF_EXE") {
        return Ok(PathBuf::from(path));
    }
    std::env::current_exe()
}

/// 定位自身 payload。`Ok(None)` 表示这是一个没有拼接 payload 的裸 exe。
pub fn locate() -> Result<Option<SelfPayload>, PayloadError> {
    locate_in(&self_exe_path().map_err(PayloadError::Io)?)
}

/// 在指定文件中定位 payload（`locate` 的可测试形态）。
pub fn locate_in(path: &std::path::Path) -> Result<Option<SelfPayload>, PayloadError> {
    let file_len = fs::metadata(path).map_err(PayloadError::Io)?.len();
    if file_len < TAIL_LEN {
        return Ok(None);
    }
    let mut f = fs::File::open(path).map_err(PayloadError::Io)?;
    use std::io::{Read, Seek, SeekFrom};
    f.seek(SeekFrom::Start(file_len - TAIL_LEN)).map_err(PayloadError::Io)?;
    let mut tail = [0u8; TAIL_LEN as usize];
    f.read_exact(&mut tail).map_err(PayloadError::Io)?;
    let (len_bytes, magic) = tail.split_at(8);
    if magic != MAGIC {
        return Ok(None);
    }
    let len = u64::from_le_bytes(len_bytes.try_into().unwrap());
    let offset = file_len - TAIL_LEN - len;
    // 长度越界（offset 下溢时上面的减法会 panic，先显式校验）
    if len > file_len - TAIL_LEN {
        return Err(PayloadError::Corrupt);
    }
    Ok(Some(SelfPayload { offset, len }))
}

/// 读出完整 payload zip 字节。
pub fn read() -> Result<Vec<u8>, PayloadError> {
    let exe = self_exe_path().map_err(PayloadError::Io)?;
    let meta = locate()?.ok_or(PayloadError::NoPayload)?;
    use std::io::{Read, Seek, SeekFrom};
    let mut f = fs::File::open(&exe).map_err(PayloadError::Io)?;
    f.seek(SeekFrom::Start(meta.offset)).map_err(PayloadError::Io)?;
    let mut buf = vec![0u8; meta.len as usize];
    f.read_exact(&mut buf).map_err(PayloadError::Io)?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试目录锚定 cargo target（而非 std::env::temp_dir）：开发环境
    /// 常在 Git bash 下跑 `cargo test`，其 `TEMP=/tmp` 会被 Windows 进程
    /// 解析到当前盘根（如 D:\tmp），可能因 ACL 拒绝写入导致测试误报。
    fn test_dir() -> std::path::PathBuf {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-tmp")
            .join("payload");
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn locate_rejects_plain_exe() {
        // 少于尾部长度的文件 → None（裸 exe 语义）
        let p = test_dir().join("plain.exe");
        std::fs::write(&p, b"MZ...short").unwrap();
        assert!(locate_in(&p).unwrap().is_none());
    }

    #[test]
    fn locate_finds_appended_payload() {
        let p = test_dir().join("sfx.exe");
        let zip = b"FAKE-ZIP-BYTES".to_vec();
        let mut bytes = b"MZ-EXE-HEADER".to_vec();
        bytes.extend_from_slice(&zip);
        bytes.extend_from_slice(&(zip.len() as u64).to_le_bytes());
        bytes.extend_from_slice(MAGIC);
        std::fs::write(&p, &bytes).unwrap();
        let meta = locate_in(&p).unwrap().expect("payload 应被定位");
        assert_eq!(meta.len as usize, zip.len());
        assert_eq!(meta.offset as usize, b"MZ-EXE-HEADER".len());
    }

    #[test]
    fn locate_flags_corrupt_tail() {
        let p = test_dir().join("corrupt.exe");
        let mut bytes = b"MZ".to_vec();
        bytes.extend_from_slice(&9999u64.to_le_bytes()); // 声明长度越界
        bytes.extend_from_slice(MAGIC);
        std::fs::write(&p, &bytes).unwrap();
        assert!(matches!(locate_in(&p), Err(PayloadError::Corrupt)));
    }
}
