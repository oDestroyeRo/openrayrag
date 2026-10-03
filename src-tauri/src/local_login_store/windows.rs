//! Owner-only NTFS storage. Every child operation is relative to a retained
//! directory handle; neither reparse points nor hard links are accepted.
use super::*;
use std::{
    ffi::OsStr,
    mem::{offset_of, size_of},
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle},
    },
    path::{Component, Prefix},
    ptr::{null, null_mut},
};
use windows_sys::{
    Wdk::{
        Foundation::OBJECT_ATTRIBUTES,
        Storage::FileSystem::{
            NtCreateFile, FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
            FILE_OPEN_IF, FILE_OPEN_REPARSE_POINT, FILE_RENAME_POSIX_SEMANTICS,
            FILE_RENAME_REPLACE_IF_EXISTS, FILE_SYNCHRONOUS_IO_NONALERT, FILE_WRITE_THROUGH,
        },
    },
    Win32::{
        Foundation::{
            CloseHandle, LocalFree, RtlNtStatusToDosError, HANDLE, INVALID_HANDLE_VALUE,
            OBJ_CASE_INSENSITIVE, OBJ_DONT_REPARSE, UNICODE_STRING,
        },
        Security::{
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            *,
        },
        Storage::FileSystem::*,
        System::{
            SystemServices::{ACCESS_ALLOWED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION},
            Threading::{GetCurrentProcess, OpenProcessToken},
            IO::{IO_STATUS_BLOCK, OVERLAPPED},
        },
    },
};

fn checked(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn handle(file: &File) -> HANDLE {
    file.as_raw_handle()
}
fn wide(name: &OsStr) -> io::Result<Vec<u16>> {
    let chars: Vec<u16> = name.encode_wide().collect();
    if chars.is_empty() || chars.contains(&0) || chars.len() > u16::MAX as usize / 2 {
        return Err(invalid());
    }
    Ok(chars)
}
fn child_name(name: &str) -> io::Result<Vec<u16>> {
    // All callers use fixed basenames. Reject separators, alternate streams,
    // normalization aliases before reaching the native API.
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.ends_with(['.', ' '])
        || name
            .chars()
            .any(|c| c.is_control() || "\\/:*?\"<>|".contains(c))
    {
        return Err(invalid());
    }
    wide(OsStr::new(name))
}

struct User {
    storage: Vec<usize>,
}
impl User {
    fn current() -> io::Result<Self> {
        let mut token = null_mut();
        // SAFETY: output is writable; token is closed before returning.
        checked(unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) })?;
        let result = (|| {
            let mut length = 0;
            unsafe { GetTokenInformation(token, TokenUser, null_mut(), 0, &mut length) };
            if length == 0 || length > 16_384 {
                return Err(invalid());
            }
            let mut storage = vec![0usize; (length as usize).div_ceil(size_of::<usize>())];
            // SAFETY: aligned owned buffer of the exact queried size.
            checked(unsafe {
                GetTokenInformation(
                    token,
                    TokenUser,
                    storage.as_mut_ptr().cast(),
                    length,
                    &mut length,
                )
            })?;
            let user = Self { storage };
            if unsafe { IsValidSid(user.sid()) } == 0 {
                return Err(invalid());
            }
            Ok(user)
        })();
        unsafe {
            CloseHandle(token);
        }
        result
    }
    fn sid(&self) -> PSID {
        // SAFETY: successful TokenUser query initialized this aligned buffer;
        // the SID points into it and remains alive for this User's lifetime.
        unsafe { (*(self.storage.as_ptr().cast::<TOKEN_USER>())).User.Sid }
    }
}
struct PrivateDescriptor {
    descriptor: SECURITY_DESCRIPTOR,
    acl: Vec<usize>,
    user: User,
}
impl PrivateDescriptor {
    fn new(directory: bool) -> io::Result<Self> {
        let user = User::current()?;
        let length = size_of::<ACL>() + size_of::<ACCESS_ALLOWED_ACE>() - size_of::<u32>()
            + unsafe { GetLengthSid(user.sid()) } as usize;
        let mut acl = vec![0usize; length.div_ceil(size_of::<usize>())];
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        // SAFETY: aligned buffers remain owned by the returned descriptor.
        unsafe {
            checked(InitializeAcl(
                acl.as_mut_ptr().cast(),
                length as u32,
                ACL_REVISION,
            ))?;
            checked(AddAccessAllowedAceEx(
                acl.as_mut_ptr().cast(),
                ACL_REVISION,
                if directory {
                    OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
                } else {
                    0
                },
                FILE_ALL_ACCESS,
                user.sid(),
            ))?;
            checked(InitializeSecurityDescriptor(
                (&mut descriptor as *mut SECURITY_DESCRIPTOR).cast(),
                SECURITY_DESCRIPTOR_REVISION,
            ))?;
        }
        let mut private = Self {
            descriptor,
            acl,
            user,
        };
        unsafe {
            checked(SetSecurityDescriptorOwner(
                private.pointer(),
                private.user.sid(),
                0,
            ))?;
            checked(SetSecurityDescriptorDacl(
                private.pointer(),
                1,
                private.acl.as_mut_ptr().cast(),
                0,
            ))?;
            checked(SetSecurityDescriptorControl(
                private.pointer(),
                SE_DACL_PROTECTED,
                SE_DACL_PROTECTED,
            ))?;
        }
        Ok(private)
    }
    fn pointer(&mut self) -> PSECURITY_DESCRIPTOR {
        (&mut self.descriptor as *mut SECURITY_DESCRIPTOR).cast()
    }
}
struct SecurityAllocation(PSECURITY_DESCRIPTOR);
impl Drop for SecurityAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}
pub(crate) fn verify_private(file: &File, directory: bool) -> io::Result<()> {
    verify_kind(file, directory)?;
    let user = User::current()?;
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: all outputs are writable; resulting allocation is owned below.
    let result = unsafe {
        GetSecurityInfo(
            handle(file),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        )
    };
    if result != 0 {
        return Err(io::Error::from_raw_os_error(result as i32));
    }
    let allocation = SecurityAllocation(descriptor);
    let mut control = 0;
    let mut revision = 0;
    unsafe {
        checked(GetSecurityDescriptorControl(
            allocation.0,
            &mut control,
            &mut revision,
        ))?;
        if owner.is_null()
            || acl.is_null()
            || EqualSid(owner, user.sid()) == 0
            || control & SE_DACL_PROTECTED == 0
            || (*acl).AceCount != 1
        {
            return Err(invalid());
        }
        let mut ace = null_mut();
        checked(GetAce(acl, 0, &mut ace))?;
        let allowed = ace.cast::<ACCESS_ALLOWED_ACE>();
        if (*allowed).Header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8
            || (*allowed).Header.AceFlags & (INHERITED_ACE | INHERIT_ONLY_ACE) as u8 != 0
            || (*allowed).Mask != FILE_ALL_ACCESS
            || EqualSid(
                (&(*allowed).SidStart as *const u32).cast_mut().cast(),
                user.sid(),
            ) == 0
        {
            return Err(invalid());
        }
    }
    Ok(())
}
fn verify_kind(file: &File, directory: bool) -> io::Result<()> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    checked(unsafe { GetFileInformationByHandle(handle(file), &mut info) })?;
    if info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
        || (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0) != directory
        || !directory && info.nNumberOfLinks != 1
    {
        return Err(invalid());
    }
    Ok(())
}
fn open_child(
    directory: &File,
    name: &[u16],
    is_directory: bool,
    disposition: u32,
    access: u32,
) -> io::Result<File> {
    let share_delete = !is_directory
        && name
            != ".operation.lock"
                .encode_utf16()
                .collect::<Vec<_>>()
                .as_slice();
    let mut descriptor = PrivateDescriptor::new(is_directory)?;
    let mut name = UNICODE_STRING {
        Length: (name.len() * 2) as u16,
        MaximumLength: (name.len() * 2) as u16,
        Buffer: name.as_ptr().cast_mut(),
    };
    let attributes = OBJECT_ATTRIBUTES {
        Length: size_of::<OBJECT_ATTRIBUTES>() as u32,
        RootDirectory: handle(directory),
        ObjectName: &mut name,
        Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
        SecurityDescriptor: descriptor.pointer().cast(),
        SecurityQualityOfService: null_mut(),
    };
    let mut status = IO_STATUS_BLOCK::default();
    let mut output = null_mut();
    // SAFETY: descriptor/name buffers live across this synchronous call. The
    // one-component relative name cannot redirect through a replaced ancestor.
    let result = unsafe {
        NtCreateFile(
            &mut output,
            access | SYNCHRONIZE,
            &attributes,
            &mut status,
            null(),
            FILE_ATTRIBUTE_NORMAL,
            FILE_SHARE_READ | FILE_SHARE_WRITE | if share_delete { FILE_SHARE_DELETE } else { 0 },
            disposition,
            FILE_OPEN_REPARSE_POINT
                | FILE_SYNCHRONOUS_IO_NONALERT
                | FILE_WRITE_THROUGH
                | if is_directory {
                    FILE_DIRECTORY_FILE
                } else {
                    FILE_NON_DIRECTORY_FILE
                },
            null(),
            0,
        )
    };
    if result < 0 {
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(result) } as i32,
        ));
    }
    // SAFETY: successful NtCreateFile returned one owned handle.
    let file = unsafe { File::from_raw_handle(output) };
    verify_kind(&file, is_directory)?;
    if disposition != FILE_OPEN {
        verify_private(&file, is_directory)?;
    }
    Ok(file)
}

/// Holds the directory against replacement and one private byte-range lock.
/// Acquisitions never block, and failed guards cannot release another owner.
pub(crate) struct FileLock {
    directory: File,
    lock: File,
    // Keep the full traversed chain against ancestor moves for this operation.
    _ancestors: Vec<File>,
}
impl std::ops::Deref for FileLock {
    type Target = File;
    fn deref(&self) -> &File {
        &self.directory
    }
}
impl FileLock {
    fn acquire(directory: File, ancestors: Vec<File>) -> io::Result<Self> {
        let lock = open_child(
            &directory,
            &child_name(".operation.lock")?,
            false,
            FILE_OPEN_IF,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        )?;
        verify_private(&lock, false)?;
        let mut overlapped = OVERLAPPED::default();
        checked(unsafe {
            LockFileEx(
                handle(&lock),
                LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                0,
                1,
                0,
                &mut overlapped,
            )
        })?;
        Ok(Self {
            directory,
            lock,
            _ancestors: ancestors,
        })
    }
}
impl Drop for FileLock {
    fn drop(&mut self) {
        let mut overlapped = OVERLAPPED::default();
        unsafe {
            UnlockFileEx(handle(&self.lock), 0, 1, 0, &mut overlapped);
        }
    }
}

pub(crate) fn open_directory(
    store: &LocalLoginStore,
    create: bool,
) -> io::Result<Option<FileLock>> {
    let mut components = store.directory.components();
    let drive = match components.next() {
        Some(Component::Prefix(p)) => match p.kind() {
            Prefix::Disk(d) | Prefix::VerbatimDisk(d) => d,
            _ => return Err(invalid()),
        },
        _ => return Err(invalid()),
    };
    if !matches!(components.next(), Some(Component::RootDir)) {
        return Err(invalid());
    }
    let names: Vec<_> = components
        .map(|c| match c {
            Component::Normal(n) => wide(n),
            _ => Err(invalid()),
        })
        .collect::<io::Result<_>>()?;
    if names.is_empty() {
        return Err(invalid());
    }
    let root: Vec<u16> = format!("\\\\?\\{}:\\", drive as char)
        .encode_utf16()
        .chain([0])
        .collect();
    let raw = unsafe {
        CreateFileW(
            root.as_ptr(),
            FILE_GENERIC_READ,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut directory = unsafe { File::from_raw_handle(raw) };
    verify_kind(&directory, true)?;
    // FILE_WRITE_THROUGH flushes NTFS metadata changes, including rename.
    // Reject filesystems whose durability/owner ACL contract differs.
    let mut filesystem = [0u16; 32];
    checked(unsafe {
        GetVolumeInformationByHandleW(
            handle(&directory),
            null_mut(),
            0,
            null_mut(),
            null_mut(),
            null_mut(),
            filesystem.as_mut_ptr(),
            filesystem.len() as u32,
        )
    })?;
    if String::from_utf16_lossy(
        &filesystem[..filesystem
            .iter()
            .position(|c| *c == 0)
            .ok_or_else(invalid)?],
    ) != "NTFS"
    {
        return Err(invalid());
    }
    let mut ancestors = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let final_directory = index + 1 == names.len();
        let access = FILE_GENERIC_READ
            | if final_directory {
                FILE_GENERIC_WRITE
            } else {
                0
            };
        let next = match open_child(&directory, name, true, FILE_OPEN, access) {
            Ok(next) => next,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !create {
                    return Ok(None);
                }
                match open_child(&directory, name, true, FILE_CREATE, access) {
                    Ok(next) => next,
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                        open_child(&directory, name, true, FILE_OPEN, access)?
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) => return Err(error),
        };
        ancestors.push(std::mem::replace(&mut directory, next));
    }
    verify_private(&directory, true)?;
    FileLock::acquire(directory, ancestors).map(Some)
}
pub(crate) fn create_private_file(directory: &File, name: &str) -> io::Result<File> {
    open_child(
        directory,
        &child_name(name)?,
        false,
        FILE_CREATE,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
    )
}
pub(crate) fn private_file(directory: &File, name: &str) -> io::Result<Option<File>> {
    let file = match open_child(
        directory,
        &child_name(name)?,
        false,
        FILE_OPEN,
        FILE_GENERIC_READ,
    ) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    verify_private(&file, false)?;
    Ok(Some(file))
}
pub(crate) fn remove_private_file(directory: &File, name: &str) -> io::Result<()> {
    let file = match open_child(
        directory,
        &child_name(name)?,
        false,
        FILE_OPEN,
        FILE_GENERIC_READ | DELETE,
    ) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    verify_private(&file, false)?;
    let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
    checked(unsafe {
        SetFileInformationByHandle(
            handle(&file),
            FileDispositionInfo,
            (&disposition as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    })
}
pub(crate) fn rename_at(directory: &File, from: &str, to: &str) -> io::Result<()> {
    private_file(directory, to)?;
    let file = open_child(
        directory,
        &child_name(from)?,
        false,
        FILE_OPEN,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE | DELETE,
    )?;
    verify_private(&file, false)?;
    let to = child_name(to)?;
    let size = offset_of!(FILE_RENAME_INFO, FileName) + to.len() * 2;
    let mut buffer = vec![0usize; size.div_ceil(size_of::<usize>())];
    let rename = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: aligned variable-length structure with sufficient trailing name.
    unsafe {
        (*rename).Anonymous.Flags = FILE_RENAME_REPLACE_IF_EXISTS | FILE_RENAME_POSIX_SEMANTICS;
        (*rename).RootDirectory = handle(directory);
        (*rename).FileNameLength = (to.len() * 2) as u32;
        std::ptr::copy_nonoverlapping(to.as_ptr(), (*rename).FileName.as_mut_ptr(), to.len());
        checked(SetFileInformationByHandle(
            handle(&file),
            FileRenameInfoEx,
            rename.cast(),
            size as u32,
        ))?;
    }
    // The renamed inode was opened FILE_WRITE_THROUGH. Check and flush the
    // exact replacement before reporting durable save success.
    file.sync_all()?;
    verify_private(&file, false)
}
pub(crate) fn sync_directory(directory: &File) -> io::Result<()> {
    verify_private(directory, true)?;
    // Windows does not provide POSIX directory fsync. Mutations use synchronous
    // write-through NTFS handles; this checked flush is the transaction fence.
    let lock = open_child(
        directory,
        &child_name(".operation.lock")?,
        false,
        FILE_OPEN,
        FILE_GENERIC_READ | FILE_GENERIC_WRITE,
    )?;
    verify_private(&lock, false)?;
    lock.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use windows_sys::Win32::Security::Authorization::{
        ConvertStringSecurityDescriptorToSecurityDescriptorW, SetSecurityInfo,
    };
    #[test]
    fn operation_lock_child() {
        let Some(path) = std::env::var_os("RAYRAG_STORAGE_LOCK_TEST_PATH") else {
            return;
        };
        let store = LocalLoginStore::settings(PathBuf::from(path));
        let expected = std::env::var("RAYRAG_STORAGE_LOCK_TEST_AVAILABLE").unwrap() == "true";
        assert_eq!(store.open_directory(false).is_ok(), expected);
    }
    #[test]
    fn operation_lock_excludes_another_process_and_releases_after_completion() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap();
        let store = LocalLoginStore::settings(path.clone());
        let guard = store.open_directory(true).unwrap().unwrap();
        let check = |available: bool| {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "login::local_store::platform::tests::operation_lock_child",
                    "--nocapture",
                ])
                .env("RAYRAG_STORAGE_LOCK_TEST_PATH", &path)
                .env("RAYRAG_STORAGE_LOCK_TEST_AVAILABLE", available.to_string())
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(String::from_utf8_lossy(&output.stdout).contains("running 1 test"));
        };
        check(false);
        drop(guard);
        check(true);
    }
    #[test]
    fn held_directory_chain_cannot_be_moved_during_transaction() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().canonicalize().unwrap().join("app");
        let store = LocalLoginStore::settings(app.clone());
        let guard = store.open_directory(true).unwrap().unwrap();
        assert!(fs::rename(&app, root.path().join("moved-app")).is_err());
        assert!(fs::rename(&store.directory, app.join("moved-settings")).is_err());
        create_private_file(&guard, "current.json")
            .unwrap()
            .write_all(b"synthetic")
            .unwrap();
        drop(guard);
        fs::rename(&app, root.path().join("moved-app")).unwrap();
    }
    #[test]
    fn permissive_dacl_is_rejected_without_repairing_existing_storage() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalLoginStore::settings(root.path().canonicalize().unwrap());
        let dir = store.open_directory(true).unwrap().unwrap();
        let created = create_private_file(&dir, "current.json").unwrap();
        drop(created);
        let file = open_child(
            &dir,
            &child_name("current.json").unwrap(),
            false,
            FILE_OPEN,
            FILE_GENERIC_READ | FILE_GENERIC_WRITE | WRITE_DAC,
        )
        .unwrap();
        file.sync_all().unwrap();
        let mut descriptor = null_mut();
        let sddl: Vec<u16> = "D:P(A;;FA;;;WD)".encode_utf16().chain([0]).collect();
        checked(unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                null_mut(),
            )
        })
        .unwrap();
        let allocation = SecurityAllocation(descriptor);
        let mut present = 0;
        let mut defaulted = 0;
        let mut acl = null_mut();
        checked(unsafe {
            GetSecurityDescriptorDacl(allocation.0, &mut present, &mut acl, &mut defaulted)
        })
        .unwrap();
        assert_eq!(
            unsafe {
                SetSecurityInfo(
                    handle(&file),
                    SE_FILE_OBJECT,
                    DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl,
                    null(),
                )
            },
            0
        );
        assert!(verify_private(&file, false).is_err());
        assert!(private_file(&dir, "current.json").is_err());
    }
    #[test]
    fn directory_reparse_point_is_rejected_before_any_child_read_or_write() {
        let root = tempfile::tempdir().unwrap();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        let linked = root.path().join("linked");
        // Junction creation needs no symlink privilege or Developer Mode.
        assert!(std::process::Command::new("cmd.exe")
            .args(["/C", "mklink", "/J"])
            .arg(&linked)
            .arg(&outside)
            .output()
            .unwrap()
            .status
            .success());
        let store = LocalLoginStore::settings(linked);
        assert!(store.open_directory(true).is_err());
        assert!(store.open_directory(false).is_err());
        assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
    }
}
