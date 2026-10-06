//! LaunchServices arguments for a new instance of the replaced application.
use std::{ffi::OsString, path::Path};

pub(crate) fn macos_arguments(binary: &Path, args: &[OsString]) -> Option<Vec<OsString>> {
    let macos = binary.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    if binary.file_name()? != "rayrag-companion"
        || macos.file_name()? != "MacOS"
        || contents.file_name()? != "Contents"
        || bundle.file_name()? != "Rayrag Companion.app"
        || !bundle.is_absolute()
    {
        return None;
    }
    // -n prevents LaunchServices from sending Reopen to the retiring process.
    // --args forwards continuation/Stop metadata without interpreting it.
    let mut launch = vec!["-n".into(), bundle.as_os_str().to_owned(), "--args".into()];
    launch.extend(args.iter().skip(1).cloned());
    Some(launch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update::update_continuation_logic::{
        restart_arguments, LAUNCH_PREFIX, STOPPED_FLAG,
    };

    #[test]
    fn launches_the_canonical_bundle_as_a_new_instance_with_exact_arguments() {
        let binary =
            Path::new("/Applications/Rayrag Companion.app/Contents/MacOS/rayrag-companion");
        let args: Vec<OsString> = vec![
            binary.into(),
            "argument with spaces".into(),
            STOPPED_FLAG.into(),
        ];
        let before = args.clone();
        let expected: Vec<OsString> = vec![
            "-n".into(),
            "/Applications/Rayrag Companion.app".into(),
            "--args".into(),
            "argument with spaces".into(),
            STOPPED_FLAG.into(),
        ];
        assert_eq!(macos_arguments(binary, &args), Some(expected.clone()));
        assert_eq!(macos_arguments(binary, &args), Some(expected));
        assert_eq!(args, before);
    }

    #[test]
    fn preserves_only_the_current_launch_authority_selected_by_continuation() {
        let binary =
            Path::new("/Applications/Rayrag Companion.app/Contents/MacOS/rayrag-companion");
        let token = uuid::Uuid::new_v4().simple().to_string();
        let old = format!("{LAUNCH_PREFIX}{token}");
        let args = vec![binary.into(), old.into(), STOPPED_FLAG.into()];
        let stopped = macos_arguments(binary, &restart_arguments(&args, true)).unwrap();
        assert_eq!(stopped.last().unwrap(), STOPPED_FLAG);
        assert_eq!(stopped.len(), 4);
        let ordinary = macos_arguments(binary, &restart_arguments(&args, false)).unwrap();
        assert_eq!(ordinary.len(), 3);
    }

    #[test]
    fn refuses_noncanonical_or_relative_executables() {
        for binary in [
            "Rayrag Companion.app/Contents/MacOS/rayrag-companion",
            "/Applications/Other.app/Contents/MacOS/rayrag-companion",
            "/Applications/Rayrag Companion.app/Contents/MacOS/other",
            "/Applications/Rayrag Companion.app/rayrag-companion",
        ] {
            assert!(macos_arguments(Path::new(binary), &[]).is_none());
        }
    }
}
