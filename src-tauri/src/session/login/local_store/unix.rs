use super::*;
use std::ffi::{CString, OsStr};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::Component;
/// Owns one successfully acquired operation lock. A forked child can retain
/// this open description even with CLOEXEC, so closing our File alone is not
/// an operation-completion boundary. Unlock before the owned File is closed.
pub(crate) struct FileLock {
    file: File,
    owner_pid: libc::pid_t,
}
impl FileLock {
    pub(crate) fn acquire(file: File) -> io::Result<Self> {
        // SAFETY: a valid owned fd. Failed acquisitions are never guards and
        // cannot unlock another operation when their unowned File is closed.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            file,
            // SAFETY: getpid has no arguments and cannot access Rust memory.
            owner_pid: unsafe { libc::getpid() },
        })
    }
}
impl std::ops::Deref for FileLock {
    type Target = File;
    fn deref(&self) -> &File {
        &self.file
    }
}
impl Drop for FileLock {
    fn drop(&mut self) {
        // SAFETY: this guard is constructed only after successful LOCK_EX; its
        // descriptor is live until File's subsequent automatic Drop. Only the
        // acquiring process can end the operation; an inherited child merely
        // closes its own descriptor and must not unlock the parent's operation.
        unsafe {
            if libc::getpid() == self.owner_pid {
                libc::flock(self.file.as_raw_fd(), libc::LOCK_UN);
            }
        }
    }
}

fn c_string(name: &OsStr) -> io::Result<CString> {
    CString::new(name.as_bytes()).map_err(|_| invalid())
}

pub(crate) fn verify_private(file: &File, directory: bool) -> io::Result<()> {
    verify_owner_mode(file, directory)?;
    access_list::require_empty(file)
}

fn verify_owner_mode(file: &File, directory: bool) -> io::Result<()> {
    let meta = file.metadata()?;
    // SAFETY: geteuid has no arguments and cannot access Rust memory.
    let owned = meta.uid() == unsafe { libc::geteuid() };
    let regular = if directory {
        meta.is_dir()
    } else {
        meta.is_file() && meta.nlink() == 1
    };
    let mode = if directory { 0o700 } else { 0o600 };
    if !owned || !regular || meta.mode() & 0o7777 != mode {
        return Err(invalid());
    }
    Ok(())
}

// macOS extended ACLs are independent of the POSIX mode bits. These bindings
// match the platform SDK's sys/acl.h and acl_get_entry(3)/acl_set_fd(3).
#[cfg(target_os = "macos")]
pub(crate) mod access_list {
    use super::*;
    use libc::{c_int, c_void};
    extern "C" {
        fn acl_get_fd(fd: c_int) -> *mut c_void;
        fn acl_init(count: c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, entry_id: c_int, entry: *mut *mut c_void) -> c_int;
        fn acl_set_fd(fd: c_int, acl: *mut c_void) -> c_int;
        fn acl_free(acl: *mut c_void) -> c_int;
    }
    struct Acl(*mut c_void);
    impl Acl {
        fn checked(pointer: *mut c_void) -> io::Result<Self> {
            if pointer.is_null() {
                Err(io::Error::last_os_error())
            } else {
                Ok(Self(pointer))
            }
        }
    }
    impl Drop for Acl {
        fn drop(&mut self) {
            // SAFETY: owned ACL allocation returned by acl_get_fd or acl_init.
            unsafe {
                acl_free(self.0);
            }
        }
    }
    pub(super) fn require_empty(file: &File) -> io::Result<()> {
        // SAFETY: valid fd; the returned ACL is independently owned.
        let pointer = unsafe { acl_get_fd(file.as_raw_fd()) };
        if pointer.is_null() {
            let error = io::Error::last_os_error();
            // The inode is already open. On macOS, ENOENT here means that its
            // extended ACL attribute is absent, not that a path was followed.
            return if error.raw_os_error() == Some(libc::ENOENT) {
                Ok(())
            } else {
                Err(error)
            };
        }
        let acl = Acl::checked(pointer)?;
        let mut entry = std::ptr::null_mut();
        // SAFETY: valid ACL and writable output pointer. Darwin returns0 for an
        // entry, and -1/EINVAL when an empty list has no first entry (ID0).
        let result = unsafe { acl_get_entry(acl.0, 0, &mut entry) };
        if result == 0 {
            return Err(invalid());
        }
        let error = io::Error::last_os_error();
        if result == -1 && error.raw_os_error() == Some(libc::EINVAL) {
            Ok(())
        } else {
            Err(error)
        }
    }
    pub(crate) fn clear(file: &File) -> io::Result<()> {
        // SAFETY: acl_init(0) returns an owned empty extended ACL.
        let empty = Acl::checked(unsafe { acl_init(0) })?;
        // SAFETY: valid fd/ACL; this affects that new inode, never a path target.
        if unsafe { acl_set_fd(file.as_raw_fd(), empty.0) } < 0 {
            return Err(io::Error::last_os_error());
        }
        require_empty(file)
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) mod access_list {
    use super::*;
    pub(super) fn require_empty(_: &File) -> io::Result<()> {
        Err(invalid())
    }
    pub(crate) fn clear(_: &File) -> io::Result<()> {
        Err(invalid())
    }
}

pub(crate) fn open_at(
    directory: &File,
    name: &str,
    flags: i32,
    mode: libc::mode_t,
) -> io::Result<File> {
    let name = c_string(OsStr::new(name))?;
    // SAFETY: live fd/name; mode supplied when O_CREAT is present. Nonblocking
    // open prevents a FIFO masquerading as a profile from hanging a read.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: successful openat returned a new fd owned solely by this File.
    Ok(unsafe { File::from_raw_fd(fd) })
}

pub(crate) fn private_file(directory: &File, name: &str) -> io::Result<Option<File>> {
    let file = match open_at(directory, name, libc::O_RDONLY, 0) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    verify_private(&file, false)?;
    Ok(Some(file))
}

pub(crate) fn remove_private_file(directory: &File, name: &str) -> io::Result<()> {
    if private_file(directory, name)?.is_none() {
        return Ok(());
    }
    let name = c_string(OsStr::new(name))?;
    // SAFETY: unlinkat removes only the descriptor-relative entry, never its target.
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn rename_at(directory: &File, from: &str, to: &str) -> io::Result<()> {
    let from = c_string(OsStr::new(from))?;
    let to = c_string(OsStr::new(to))?;
    // SAFETY: both names are live; same-directory rename replaces atomically.
    if unsafe {
        libc::renameat(
            directory.as_raw_fd(),
            from.as_ptr(),
            directory.as_raw_fd(),
            to.as_ptr(),
        )
    } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

impl LocalLoginStore {
    pub(super) fn open_directory_with(
        &self,
        create: bool,
        mut sync_parent: impl FnMut(&File) -> io::Result<()>,
    ) -> io::Result<Option<FileLock>> {
        if !self.directory.is_absolute() {
            return Err(invalid());
        }
        let mut directory = File::open("/")?;
        for component in self.directory.components() {
            let name = match component {
                Component::RootDir => continue,
                Component::Normal(name) => name,
                _ => return Err(invalid()),
            };
            let name = c_string(name)?;
            let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
            let mut created = false;
            // SAFETY: live directory fd and NUL-terminated name; returned fd is
            // exclusively owned by File. Each ancestor is opened without links.
            let mut fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            if fd < 0 && io::Error::last_os_error().kind() == io::ErrorKind::NotFound {
                if !create {
                    return Ok(None);
                }
                // SAFETY: same descriptor-relative path; new directories are private.
                let made = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
                if made < 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
                    return Err(io::Error::last_os_error());
                }
                created = made == 0;
                // SAFETY: as above; O_NOFOLLOW also covers a creation race.
                fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
            }
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful openat produced an owned, nonnegative fd.
            let next = unsafe { File::from_raw_fd(fd) };
            if created {
                verify_owner_mode(&next, true)?;
                // A parent's inherited ACL can grant access despite mode0700.
                // Clear only directories we just created, before storing secrets.
                access_list::clear(&next)?;
                verify_private(&next, true)?;
                next.sync_all()?;
                // Persist the entry in its parent before reporting first-save success.
                sync_parent(&directory)?;
            }
            directory = next;
        }
        verify_private(&directory, true)?;
        // Nonblocking ownership avoids hanging the login UI on another save.
        FileLock::acquire(directory).map(Some)
    }
}
pub(crate) fn open_directory(
    store: &LocalLoginStore,
    create: bool,
) -> io::Result<Option<FileLock>> {
    store.open_directory_with(create, |parent| parent.sync_all())
}
pub(crate) fn create_private_file(directory: &File, name: &str) -> io::Result<File> {
    let file = open_at(
        directory,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )?;
    file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    verify_owner_mode(&file, false)?;
    access_list::clear(&file)?;
    verify_private(&file, false)?;
    Ok(file)
}
pub(crate) fn sync_directory(directory: &File) -> io::Result<()> {
    directory.sync_all()
}

#[cfg(all(test, target_os = "macos"))]
pub(crate) use tests::InheritedLock;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, DirBuilder, OpenOptions};
    use std::os::unix::fs::{symlink, DirBuilderExt, OpenOptionsExt};
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);

    struct TemporaryRoot(PathBuf);
    impl TemporaryRoot {
        fn new() -> Self {
            let parent = std::env::temp_dir().canonicalize().unwrap();
            let path = parent.join(format!(
                "rayrag-login-test-{}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            DirBuilder::new().mode(0o700).create(&path).unwrap();
            Self(path)
        }
        fn store(&self) -> LocalLoginStore {
            LocalLoginStore::new(self.0.join("app-data"))
        }
    }
    impl Drop for TemporaryRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn profile() -> LoginProfile {
        LoginProfile {
            mode: crate::session::login::ConnectionMode::GameClient,
            username: "synthetic-account".into(),
            password: "synthetic-only-password".into(),
            character_slot: 2,
            auto_login: true,
        }
    }
    fn write_private(path: &std::path::Path, bytes: &[u8]) {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .unwrap();
        file.write_all(bytes).unwrap();
    }
    fn assert_rejected(store: &LocalLoginStore) {
        assert_eq!(store.load().err().unwrap(), READ_ERROR);
        assert_eq!(store.save(&profile()).err().unwrap(), SAVE_ERROR);
        assert_eq!(store.forget().err().unwrap(), FORGET_ERROR);
    }

    #[test]
    fn local_profile_round_trip_atomic_update_permissions_and_forget() {
        let root = TemporaryRoot::new();
        let store = root.store();
        assert!(store.load().unwrap().is_none());
        store.forget().unwrap();
        assert!(!store.directory.exists()); // reads and Forget do not create a store
        let mut original = profile();
        store.save(&original).unwrap();
        let path = store.directory.join(PROFILE);
        let mut previous = File::open(&path).unwrap();
        assert_eq!(
            fs::metadata(&store.directory).unwrap().mode() & 0o7777,
            0o700
        );
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o7777, 0o600);
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.username, original.username);
        assert_eq!(loaded.password, original.password);
        assert_eq!(loaded.character_slot, 2);
        assert!(loaded.auto_login);
        let inode = previous.metadata().unwrap().ino();
        original.password = "synthetic-updated-password".into();
        original.character_slot = 0;
        original.auto_login = false;
        store.save(&original).unwrap();
        assert_ne!(fs::metadata(&path).unwrap().ino(), inode);
        let mut old = Vec::new();
        previous.read_to_end(&mut old).unwrap();
        let old: LoginProfile = serde_json::from_slice(&old).unwrap();
        assert_eq!(old.password, profile().password); // no truncation of the old inode
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.password, original.password);
        assert_eq!(loaded.character_slot, 0);
        assert!(!loaded.auto_login);
        write_private(
            &store.directory.join(TEMPORARY),
            b"synthetic stale partial write",
        );
        store.forget().unwrap();
        store.forget().unwrap();
        assert!(store.load().unwrap().is_none());
        assert!(!path.exists());
        assert!(!store.directory.join(TEMPORARY).exists());
    }

    #[test]
    fn bounded_invalid_and_unknown_profile_data_fail_without_secret_errors() {
        let root = TemporaryRoot::new();
        let store = root.store();
        store.save(&profile()).unwrap();
        let mut invalid = serde_json::to_value(profile()).unwrap();
        invalid["characterSlot"] = 3.into();
        let mut unknown = serde_json::to_value(profile()).unwrap();
        unknown["extra"] = "synthetic-private-marker".into();
        let cases = vec![
            Vec::new(),
            b"synthetic-private-marker".to_vec(),
            vec![0xff],
            vec![b' '; MAX_BYTES as usize + 1],
            serde_json::to_vec(&invalid).unwrap(),
            serde_json::to_vec(&unknown).unwrap(),
        ];
        for bytes in cases {
            fs::write(store.directory.join(PROFILE), bytes).unwrap();
            assert_eq!(store.load().err().unwrap(), READ_ERROR);
        }
        // A valid explicit replacement or Forget can recover corrupt regular data.
        store.save(&profile()).unwrap();
        assert!(store.load().unwrap().is_some());
        store.forget().unwrap();
    }

    #[test]
    fn partial_write_failure_preserves_previous_profile_and_cleans_temporary() {
        let root = TemporaryRoot::new();
        let store = root.store();
        store.save(&profile()).unwrap();
        let before = fs::read(store.directory.join(PROFILE)).unwrap();
        let error = store
            .save_with(&profile(), |file, _| {
                file.write_all(b"partial synthetic write")?;
                Err(io::Error::other("synthetic-private-marker"))
            })
            .err()
            .unwrap();
        assert_eq!(error, SAVE_ERROR);
        assert_eq!(fs::read(store.directory.join(PROFILE)).unwrap(), before);
        assert!(!store.directory.join(TEMPORARY).exists());
        assert!(store.load().unwrap().is_some());
    }

    #[test]
    fn invalid_input_and_nonabsolute_path_do_not_create_a_profile() {
        let root = TemporaryRoot::new();
        let store = root.store();
        let mut invalid_profile = profile();
        invalid_profile.password.clear();
        assert_eq!(store.save(&invalid_profile).err().unwrap(), SAVE_ERROR);
        assert!(!store.directory.exists());
        let relative = LocalLoginStore::new(PathBuf::from("relative"));
        assert_rejected(&relative);
        let traversal = LocalLoginStore::new(root.0.join(".."));
        assert_rejected(&traversal);
    }

    #[test]
    fn symlink_profile_and_temporary_are_not_followed_or_deleted() {
        for name in [PROFILE, TEMPORARY] {
            let root = TemporaryRoot::new();
            let store = root.store();
            store.save(&profile()).unwrap();
            let outside = root.0.join("outside");
            write_private(&outside, b"synthetic outside content");
            let unsafe_path = store.directory.join(name);
            if unsafe_path.exists() {
                fs::remove_file(&unsafe_path).unwrap();
            }
            symlink(&outside, &unsafe_path).unwrap();
            if name == PROFILE {
                assert_rejected(&store);
            } else {
                assert_eq!(store.save(&profile()).err().unwrap(), SAVE_ERROR);
                assert_eq!(store.forget().err().unwrap(), FORGET_ERROR);
                assert!(store.load().unwrap().is_some());
            }
            assert!(fs::symlink_metadata(unsafe_path).unwrap().is_symlink());
            assert_eq!(fs::read(outside).unwrap(), b"synthetic outside content");
        }
    }

    #[test]
    fn symlink_or_regular_file_ancestors_and_store_directory_are_rejected() {
        for final_directory in [false, true] {
            let root = TemporaryRoot::new();
            let store = root.store();
            let outside = root.0.join("outside");
            DirBuilder::new().mode(0o700).create(&outside).unwrap();
            let unsafe_path = if final_directory {
                DirBuilder::new()
                    .mode(0o700)
                    .create(store.directory.parent().unwrap())
                    .unwrap();
                store.directory.clone()
            } else {
                store.directory.parent().unwrap().to_owned()
            };
            symlink(&outside, &unsafe_path).unwrap();
            assert_rejected(&store);
            assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
            fs::remove_file(&unsafe_path).unwrap();
            write_private(&unsafe_path, b"synthetic non-directory");
            assert_rejected(&store);
        }
    }

    #[test]
    fn nonregular_profile_and_hard_links_are_rejected_without_blocking() {
        for fifo in [false, true] {
            let root = TemporaryRoot::new();
            let store = root.store();
            store.save(&profile()).unwrap();
            let path = store.directory.join(PROFILE);
            fs::remove_file(&path).unwrap();
            if fifo {
                let path = c_string(path.as_os_str()).unwrap();
                // SAFETY: synthetic NUL-terminated test path, no real app data.
                assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
            } else {
                fs::create_dir(&path).unwrap();
            }
            assert_rejected(&store);
        }
        let root = TemporaryRoot::new();
        let store = root.store();
        store.save(&profile()).unwrap();
        let alias = root.0.join("alias");
        fs::hard_link(store.directory.join(PROFILE), &alias).unwrap();
        let before = fs::read(&alias).unwrap();
        assert_rejected(&store);
        assert_eq!(fs::read(alias).unwrap(), before);
    }

    #[test]
    fn non_private_modes_are_rejected_without_changing_previous_data() {
        let root = TemporaryRoot::new();
        let store = root.store();
        store.save(&profile()).unwrap();
        let path = store.directory.join(PROFILE);
        let before = fs::read(&path).unwrap();
        fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert_rejected(&store);
        fs::set_permissions(&store.directory, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_rejected(&store);
        assert_eq!(fs::read(path).unwrap(), before);
    }

    // The child uses only async-signal-safe libc calls between fork and _exit.
    // It retains the inherited open description until an explicit parent signal.
    pub(crate) struct InheritedLock {
        pid: libc::pid_t,
        release: File,
    }
    impl InheritedLock {
        pub(crate) fn new(directory_fd: libc::c_int) -> Self {
            Self::fork(directory_fd, None)
        }
        pub(crate) fn dropping_copy(guard: &mut FileLock) -> Self {
            Self::fork(guard.as_raw_fd(), Some(guard as *mut FileLock))
        }
        fn fork(directory_fd: libc::c_int, drop_copy: Option<*mut FileLock>) -> Self {
            let mut ready = [0; 2];
            let mut release = [0; 2];
            // SAFETY: writable two-fd arrays, owned below after successful pipe.
            assert_eq!(unsafe { libc::pipe(ready.as_mut_ptr()) }, 0);
            assert_eq!(unsafe { libc::pipe(release.as_mut_ptr()) }, 0);
            // SAFETY: these four pipe fds were just created and are exclusively owned.
            let (mut ready_read, ready_write, release_read, release_write) = unsafe {
                (
                    File::from_raw_fd(ready[0]),
                    File::from_raw_fd(ready[1]),
                    File::from_raw_fd(release[0]),
                    File::from_raw_fd(release[1]),
                )
            };
            // SAFETY: the child runs only the descriptor guard's libc/close Drop
            // and async-signal-safe syscalls, without allocation or other cleanup.
            let pid = unsafe { libc::fork() };
            assert!(pid >= 0);
            if pid == 0 {
                // SAFETY: inherited live fds and stack bytes; _exit avoids Rust Drop.
                unsafe {
                    libc::close(ready[0]);
                    libc::close(release[1]);
                    if let Some(guard) = drop_copy {
                        std::ptr::drop_in_place(guard);
                    }
                    let mut signal = 1u8;
                    let wrote = libc::write(ready[1], (&signal as *const u8).cast(), 1);
                    let read = libc::read(release[0], (&mut signal as *mut u8).cast(), 1);
                    if drop_copy.is_none() {
                        libc::close(directory_fd);
                    }
                    libc::_exit(if wrote == 1 && read == 1 { 0 } else { 1 });
                }
            }
            drop(ready_write);
            drop(release_read);
            let child = Self {
                pid,
                release: release_write,
            };
            let mut ready = [0u8; 1];
            ready_read.read_exact(&mut ready).unwrap();
            child
        }
        pub(crate) fn finish(&mut self) -> i32 {
            let _ = self.release.write_all(&[1]);
            let mut status = 0;
            loop {
                // SAFETY: this pid is our child and status is a writable integer.
                let waited = unsafe { libc::waitpid(self.pid, &mut status, 0) };
                if waited == self.pid {
                    self.pid = 0;
                    return status;
                }
                if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                    self.pid = 0;
                    return -1;
                }
            }
        }
    }
    impl Drop for InheritedLock {
        fn drop(&mut self) {
            if self.pid != 0 {
                self.finish();
            }
        }
    }

    #[test]
    fn operation_completion_unlocks_while_a_child_retains_the_directory() {
        for settings in [false, true] {
            let root = TemporaryRoot::new();
            let store = if settings {
                LocalLoginStore::settings(root.0.join("app-data"))
            } else {
                root.store()
            };
            let guard = store.open_directory(true).unwrap().unwrap();
            // CLOEXEC does not prevent inheritance between fork and exec.
            // SAFETY: valid borrowed descriptor; F_GETFD does not alter ownership.
            assert_ne!(
                unsafe { libc::fcntl(guard.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
                0
            );
            let mut child = InheritedLock::new(guard.as_raw_fd());
            assert_eq!(
                store.open_directory(false).err().unwrap().kind(),
                io::ErrorKind::WouldBlock
            );
            // Failed, unowned acquisitions must never unlock the active operation.
            assert_eq!(
                store.open_directory(false).err().unwrap().kind(),
                io::ErrorKind::WouldBlock
            );
            drop(guard);
            let reopened = store.open_directory(false);
            let released_before_child_close = reopened.is_ok();
            let excludes_during_new_operation = store.open_directory(false).err().map(|e| e.kind());
            drop(reopened);
            let operation_can_finish_again = store.open_directory(false).is_ok();
            // Always release/reap before asserting the failing post-drop result.
            let child_status = child.finish();
            assert_eq!(child_status, 0);
            assert!(
                released_before_child_close,
                "operation lock survived owner completion"
            );
            assert_eq!(
                excludes_during_new_operation,
                Some(io::ErrorKind::WouldBlock)
            );
            assert!(operation_can_finish_again);
        }
    }

    #[test]
    fn inherited_child_drop_cannot_release_the_active_parent_operation() {
        let root = TemporaryRoot::new();
        let store = root.store();
        let mut guard = store.open_directory(true).unwrap().unwrap();
        let mut retained = InheritedLock::new(guard.as_raw_fd());
        let mut dropping = InheritedLock::dropping_copy(&mut guard);
        // The ready signal follows actual child guard Drop, not just fork.
        let active_parent_excludes = store.open_directory(false).err().map(|e| e.kind());
        drop(guard);
        let released_by_parent = store.open_directory(false).is_ok();
        let dropping_status = dropping.finish();
        let retained_status = retained.finish();
        assert_eq!(dropping_status, 0);
        assert_eq!(retained_status, 0);
        assert_eq!(active_parent_excludes, Some(io::ErrorKind::WouldBlock));
        assert!(released_by_parent);
    }

    #[test]
    fn failed_save_load_and_forget_release_the_operation_lock() {
        let root = TemporaryRoot::new();
        let store = root.store();
        store.save(&profile()).unwrap();
        assert_eq!(
            store
                .save_with(&profile(), |_, _| Err(io::Error::other(
                    "synthetic write failure"
                )))
                .unwrap_err(),
            SAVE_ERROR
        );
        drop(store.open_directory(false).unwrap().unwrap());
        fs::write(store.directory.join(PROFILE), b"synthetic malformed data").unwrap();
        assert_eq!(store.load().err().unwrap(), READ_ERROR);
        drop(store.open_directory(false).unwrap().unwrap());
        store.save(&profile()).unwrap();
        let outside = root.0.join("outside");
        write_private(&outside, b"synthetic untouched data");
        symlink(&outside, store.directory.join(TEMPORARY)).unwrap();
        assert_eq!(store.forget().unwrap_err(), FORGET_ERROR);
        drop(store.open_directory(false).unwrap().unwrap());
        fs::remove_file(store.directory.join(TEMPORARY)).unwrap();
        store.forget().unwrap();
        assert!(store.load().unwrap().is_none());
        assert_eq!(fs::read(outside).unwrap(), b"synthetic untouched data");
    }

    #[test]
    fn directory_lock_prevents_overlapping_store_operations() {
        let root = TemporaryRoot::new();
        let store = root.store();
        store.save(&profile()).unwrap();
        let guard = store.open_directory(false).unwrap().unwrap();
        assert_rejected(&store);
        drop(guard);
        assert!(store.load().unwrap().is_some());
    }

    #[test]
    fn newly_created_directory_entries_are_synced_before_success() {
        let root = TemporaryRoot::new();
        let store = root.store();
        let mut parents = Vec::new();
        let directory = store
            .open_directory_with(true, |parent| {
                parents.push(parent.metadata()?.ino());
                parent.sync_all()
            })
            .unwrap()
            .unwrap();
        assert_eq!(
            parents,
            vec![
                fs::metadata(&root.0).unwrap().ino(),
                fs::metadata(store.directory.parent().unwrap())
                    .unwrap()
                    .ino()
            ]
        );
        drop(directory);
        store.save(&profile()).unwrap();
        let other = LocalLoginStore::new(root.0.join("failed-parent-sync"));
        assert!(other
            .open_directory_with(true, |_| Err(io::Error::other("synthetic sync failure")))
            .is_err());
        assert!(!other.directory.exists());
        assert!(other.load().unwrap().is_none());
    }

    #[cfg(target_os = "macos")]
    fn grant_synthetic_acl(path: &std::path::Path, inherited: bool) {
        let rule = if inherited {
            "everyone allow read,execute,readattr,readextattr,readsecurity,file_inherit,directory_inherit"
        } else {
            "everyone allow read,readattr,readextattr,readsecurity"
        };
        assert!(std::process::Command::new("/bin/chmod")
            .arg("+a")
            .arg(rule)
            .arg(path)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn existing_extended_acls_are_rejected_without_modifying_them() {
        for name in [None, Some(PROFILE), Some(TEMPORARY)] {
            let root = TemporaryRoot::new();
            let store = root.store();
            store.save(&profile()).unwrap();
            let path = name.map_or_else(
                || store.directory.clone(),
                |name| store.directory.join(name),
            );
            if name == Some(TEMPORARY) {
                write_private(&path, b"synthetic leftover");
            }
            grant_synthetic_acl(&path, false);
            let entry = File::open(&path).unwrap();
            assert_eq!(
                entry.metadata().unwrap().mode() & 0o7777,
                if name.is_none() { 0o700 } else { 0o600 }
            );
            if name == Some(TEMPORARY) {
                assert!(store.load().unwrap().is_some());
                assert_eq!(store.save(&profile()).err().unwrap(), SAVE_ERROR);
                assert_eq!(store.forget().err().unwrap(), FORGET_ERROR);
            } else {
                assert_rejected(&store);
            }
            assert!(access_list::require_empty(&entry).is_err());
        }
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn inherited_acls_are_cleared_on_new_directories_and_before_secret_writes() {
        let root = TemporaryRoot::new();
        let store = root.store();
        grant_synthetic_acl(&root.0, true);
        store
            .save_with(&profile(), |file, bytes| {
                // Verify the exact destination inode before the first secret byte.
                verify_private(file, false)?;
                file.write_all(bytes)
            })
            .unwrap();
        let parent = File::open(store.directory.parent().unwrap()).unwrap();
        verify_private(&parent, true).unwrap();
        verify_private(&File::open(&store.directory).unwrap(), true).unwrap();
        verify_private(&File::open(store.directory.join(PROFILE)).unwrap(), false).unwrap();
        assert!(store.load().unwrap().is_some());
        // Even an existing app-data ancestor may carry an inheritable ACL;
        // clearing only the new store directory prevents propagation to its file.
        let other = LocalLoginStore::new(root.0.join("existing-app-data"));
        DirBuilder::new()
            .mode(0o700)
            .create(other.directory.parent().unwrap())
            .unwrap();
        grant_synthetic_acl(other.directory.parent().unwrap(), true);
        other.save(&profile()).unwrap();
        verify_private(&File::open(&other.directory).unwrap(), true).unwrap();
        verify_private(&File::open(other.directory.join(PROFILE)).unwrap(), false).unwrap();
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod access_list {
    use super::*;
    const ACCESS: &[u8] = b"system.posix_acl_access\0";
    const DEFAULT: &[u8] = b"system.posix_acl_default\0";
    fn absent(error: &io::Error) -> bool {
        matches!(
            error.raw_os_error(),
            Some(libc::ENODATA) | Some(libc::EOPNOTSUPP)
        )
    }
    pub(super) fn require_empty(file: &File) -> io::Result<()> {
        for name in [ACCESS, DEFAULT] {
            // SAFETY: live fd, static NUL-terminated attribute, size-only query.
            let result = unsafe {
                libc::fgetxattr(
                    file.as_raw_fd(),
                    name.as_ptr().cast(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            if result >= 0 {
                return Err(invalid());
            }
            let error = io::Error::last_os_error();
            if !absent(&error) {
                return Err(error);
            }
        }
        Ok(())
    }
    pub(crate) fn clear(file: &File) -> io::Result<()> {
        for name in [ACCESS, DEFAULT] {
            // SAFETY: remove only this open inode's access/default ACL. Filesystems
            // without POSIX ACL support cannot retain either grant.
            if unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr().cast()) } < 0 {
                let error = io::Error::last_os_error();
                if !absent(&error) {
                    return Err(error);
                }
            }
        }
        require_empty(file)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_acl_tests {
    use super::*;
    fn grant_acl(file: &File, default: bool) {
        let mut bytes = 2u32.to_le_bytes().to_vec();
        for (tag, permissions, id) in [
            (1u16, if default { 7u16 } else { 6 }, u32::MAX),
            (2, 4, unsafe { libc::geteuid() }.wrapping_add(1)),
            (4, 0, u32::MAX),
            (16, if default { 4 } else { 0 }, u32::MAX),
            (32, 0, u32::MAX),
        ] {
            bytes.extend(tag.to_le_bytes());
            bytes.extend(permissions.to_le_bytes());
            bytes.extend(id.to_le_bytes());
        }
        let name: &[u8] = if default {
            b"system.posix_acl_default\0"
        } else {
            b"system.posix_acl_access\0"
        };
        // SAFETY: descriptor and kernel POSIX ACL xattr byte format are live.
        let result = unsafe {
            libc::fsetxattr(
                file.as_raw_fd(),
                name.as_ptr().cast(),
                bytes.as_ptr().cast(),
                bytes.len(),
                0,
            )
        };
        assert_eq!(
            result,
            0,
            "synthetic ACL setup: {}",
            io::Error::last_os_error()
        );
    }
    #[test]
    fn existing_posix_acl_is_rejected_without_repair() {
        let root = tempfile::tempdir().unwrap();
        let store = LocalLoginStore::settings(root.path().canonicalize().unwrap());
        let directory = store.open_directory(true).unwrap().unwrap();
        let file = create_private_file(&directory, "current.json").unwrap();
        grant_acl(&file, false);
        assert_eq!(file.metadata().unwrap().mode() & 0o7777, 0o600);
        assert!(verify_private(&file, false).is_err());
        assert!(private_file(&directory, "current.json").is_err());
        assert!(access_list::require_empty(&file).is_err());
    }
    #[test]
    fn inherited_access_and_default_acls_clear_before_first_write() {
        let root = tempfile::tempdir().unwrap();
        let parent = File::open(root.path()).unwrap();
        grant_acl(&parent, true);
        let store = LocalLoginStore::settings(root.path().canonicalize().unwrap().join("app"));
        let directory = store.open_directory(true).unwrap().unwrap();
        verify_private(&directory, true).unwrap();
        let file = create_private_file(&directory, "current.json").unwrap();
        verify_private(&file, false).unwrap();
        // Also prove the default attribute is removed from new ancestors.
        let app = File::open(store.directory.parent().unwrap()).unwrap();
        access_list::require_empty(&app).unwrap();
        assert!(access_list::require_empty(&parent).is_err());
    }
}
