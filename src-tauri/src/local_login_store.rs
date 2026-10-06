//! Native-only, unencrypted local persistence. Never expose bytes or OS errors to IPC.
use super::LoginProfile;
use crate::local_login_logic::{self as document, MAX_BYTES};
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::PathBuf;

const PROFILE: &str = "profile.json";
const TEMPORARY: &str = ".profile.tmp";
const READ_ERROR: &str =
    "Could not read the local saved login. Forget it or enter your account manually.";
const SAVE_ERROR: &str = "Could not save the login on this computer.";
const FORGET_ERROR: &str = "Could not remove the local saved login.";

pub(crate) struct LocalLoginStore {
    directory: PathBuf,
}

impl LocalLoginStore {
    pub(crate) fn settings(app_data: PathBuf) -> Self {
        Self {
            directory: app_data.join("settings"),
        }
    }
    pub(crate) fn new(app_data: PathBuf) -> Self {
        Self {
            directory: app_data.join("login"),
        }
    }

    pub(super) fn load(&self) -> Result<Option<LoginProfile>, String> {
        let read = || -> io::Result<Option<LoginProfile>> {
            let Some(directory) = self.open_directory(false)? else {
                return Ok(None);
            };
            let Some(file) = private_file(&directory, PROFILE)? else {
                return Ok(None);
            };
            if file.metadata()?.len() > MAX_BYTES {
                return Err(invalid());
            }
            let mut bytes = Vec::new();
            file.take(MAX_BYTES + 1).read_to_end(&mut bytes)?;
            let profile = document::parse(&bytes).map_err(|_| invalid())?;
            Ok(Some(profile))
        };
        read().map_err(|_| READ_ERROR.into())
    }

    pub(super) fn save(&self, profile: &LoginProfile) -> Result<(), String> {
        self.save_with(profile, |file, bytes| file.write_all(bytes))
    }

    fn save_with(
        &self,
        profile: &LoginProfile,
        write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    ) -> Result<(), String> {
        let save = || -> io::Result<()> {
            let bytes = document::encode(profile).map_err(|_| invalid())?;
            let directory = self.open_directory(true)?.ok_or_else(invalid)?;
            // Reject unsafe destination and stale temporary entries, including
            // hard links. A directory lock coordinates other app processes.
            private_file(&directory, PROFILE)?;
            remove_private_file(&directory, TEMPORARY)?;
            let temporary = create_private_file(&directory, TEMPORARY)?;
            let result = (|| {
                verify_private(&temporary, false)?;
                let mut temporary = temporary;
                write(&mut temporary, &bytes)?;
                temporary.sync_all()?;
                private_file(&directory, PROFILE)?;
                rename_at(&directory, TEMPORARY, PROFILE)?;
                sync_directory(&directory)
            })();
            // Clean only our fixed, private temporary entry. Failure to commit
            // never removes or truncates the preceding profile.
            if result.is_err() {
                let _ = remove_private_file(&directory, TEMPORARY);
            }
            result
        };
        save().map_err(|_| SAVE_ERROR.into())
    }

    pub(super) fn forget(&self) -> Result<(), String> {
        let forget = || -> io::Result<()> {
            let Some(directory) = self.open_directory(false)? else {
                return Ok(());
            };
            // Validate both before deleting either. No unsafe entry is followed.
            private_file(&directory, PROFILE)?;
            private_file(&directory, TEMPORARY)?;
            remove_private_file(&directory, PROFILE)?;
            remove_private_file(&directory, TEMPORARY)?;
            sync_directory(&directory)
        };
        forget().map_err(|_| FORGET_ERROR.into())
    }

    pub(crate) fn open_directory(&self, create: bool) -> io::Result<Option<FileLock>> {
        platform::open_directory(self, create)
    }
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid local login store")
}

#[cfg(unix)]
#[path = "local_login_store/unix.rs"]
mod platform;
#[cfg(windows)]
#[path = "local_login_store/windows.rs"]
mod platform;
#[cfg(target_os = "macos")]
pub(crate) use platform::access_list;
#[cfg(all(test, target_os = "macos"))]
pub(crate) use platform::InheritedLock;
pub(crate) use platform::{
    create_private_file, private_file, remove_private_file, rename_at, sync_directory,
    verify_private, FileLock,
};

#[cfg(test)]
mod portable_tests {
    use super::*;
    use std::fs;
    fn profile() -> LoginProfile {
        LoginProfile {
            mode: crate::login::ConnectionMode::GameClient,
            username: "synthetic-account".into(),
            password: "synthetic-password".into(),
            character_slot: 1,
            auto_login: true,
        }
    }
    fn root() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }
    #[test]
    fn owner_private_roundtrip_repeated_atomic_saves_and_forget() {
        let root = root();
        let store = LocalLoginStore::new(root.path().canonicalize().unwrap().join("app"));
        assert!(store.load().unwrap().is_none());
        store.save(&profile()).unwrap();
        let previous = File::open(store.directory.join(PROFILE)).unwrap();
        let before = fs::read(store.directory.join(PROFILE)).unwrap();
        for slot in [0, 2, 1] {
            let mut next = profile();
            next.character_slot = slot;
            store.save(&next).unwrap();
            assert_eq!(store.load().unwrap().unwrap().character_slot, slot);
            let dir = store.open_directory(false).unwrap().unwrap();
            verify_private(&dir, true).unwrap();
            verify_private(&private_file(&dir, PROFILE).unwrap().unwrap(), false).unwrap();
        }
        let mut old = Vec::new();
        previous.take(MAX_BYTES).read_to_end(&mut old).unwrap();
        assert_eq!(old, before); // An open reader keeps the unmodified old inode.
        store.forget().unwrap();
        assert!(store.load().unwrap().is_none());
    }
    #[test]
    fn conflicting_operation_is_nonblocking_and_releases_after_failure() {
        let root = root();
        let store = LocalLoginStore::new(root.path().canonicalize().unwrap());
        store.save(&profile()).unwrap();
        let held = store.open_directory(false).unwrap().unwrap();
        assert!(store.save(&profile()).is_err());
        assert!(store.load().is_err());
        assert!(store.forget().is_err());
        // A failed acquisition does not accidentally unlock the active guard.
        assert!(store.open_directory(false).is_err());
        drop(held);
        store.save(&profile()).unwrap();
        assert!(store.load().unwrap().is_some());
    }
    #[test]
    fn partial_write_failure_retains_confirmed_data_and_allows_retry() {
        let root = root();
        let store = LocalLoginStore::new(root.path().canonicalize().unwrap());
        store.save(&profile()).unwrap();
        let before = fs::read(store.directory.join(PROFILE)).unwrap();
        assert_eq!(
            store
                .save_with(&profile(), |f, _| {
                    f.write_all(b"synthetic partial")?;
                    Err(io::Error::other("injected failure"))
                })
                .unwrap_err(),
            SAVE_ERROR
        );
        assert_eq!(fs::read(store.directory.join(PROFILE)).unwrap(), before);
        assert!(!store.directory.join(TEMPORARY).exists());
        store.save(&profile()).unwrap();
    }
    #[test]
    fn hardlinked_profile_and_temporary_reject_without_mutation() {
        for name in [PROFILE, TEMPORARY] {
            let root = root();
            let store = LocalLoginStore::new(root.path().canonicalize().unwrap());
            store.save(&profile()).unwrap();
            let path = store.directory.join(name);
            if name == TEMPORARY {
                let dir = store.open_directory(false).unwrap().unwrap();
                create_private_file(&dir, name)
                    .unwrap()
                    .write_all(b"synthetic stale")
                    .unwrap();
            }
            let outside = root.path().join("outside");
            fs::hard_link(&path, &outside).unwrap();
            let before = fs::read(&outside).unwrap();
            assert!(store.save(&profile()).is_err());
            assert!(store.forget().is_err());
            if name == PROFILE {
                assert!(store.load().is_err());
            }
            assert_eq!(fs::read(outside).unwrap(), before);
        }
    }
}
