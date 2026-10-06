//! Pinned public compatibility admission, without network or runtime effects.
pub(crate) const VERIFIED_BUILD: &str = "Build_2569-09-01-01-55";

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CompatibilityError {
    ProtocolVersion,
    GameBuild,
}
impl From<CompatibilityError> for String {
    fn from(error: CompatibilityError) -> Self {
        match error {
            CompatibilityError::ProtocolVersion => "This server protocol version is not verified.",
            CompatibilityError::GameBuild => "This game build is not verified.",
        }
        .into()
    }
}

// Private construction retains the protocol-before-build admission contract.
pub(crate) struct VerifiedProtocol(());
pub(crate) struct VerifiedCompatibility(());
impl VerifiedProtocol {
    pub(crate) fn admit(bytes: &[u8]) -> Result<Self, CompatibilityError> {
        if bytes
            .iter()
            .copied()
            .filter(|b| !b.is_ascii_whitespace())
            .eq(*b"8")
        {
            Ok(Self(()))
        } else {
            Err(CompatibilityError::ProtocolVersion)
        }
    }

    pub(crate) fn admit_build(
        self,
        bytes: &[u8],
    ) -> Result<VerifiedCompatibility, CompatibilityError> {
        let text = std::str::from_utf8(bytes).map_err(|_| CompatibilityError::GameBuild)?;
        // Inert text only: exactly one pinned declaration, no execution or Unity downloads.
        let declaration = format!("var buildUrl = \"{VERIFIED_BUILD}\";");
        if text.matches("var buildUrl").count() == 1 && text.contains(&declaration) {
            Ok(VerifiedCompatibility(()))
        } else {
            Err(CompatibilityError::GameBuild)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(bytes: &[u8]) -> Result<VerifiedCompatibility, CompatibilityError> {
        VerifiedProtocol::admit(b"8")?.admit_build(bytes)
    }

    #[test]
    fn only_the_pinned_protocol_with_ascii_whitespace_is_admitted() {
        for bytes in [b"8".as_slice(), b"\t\r\n 8 \x0c"] {
            assert!(VerifiedProtocol::admit(bytes).is_ok());
        }
        for bytes in [
            b"".as_slice(),
            b" \n\t",
            b"08",
            b"8.0",
            b"9",
            b"8 8",
            b"8\0",
            b"8\xff",
            b"\xef\xbb\xbf8",
        ] {
            for _ in 0..2 {
                assert!(matches!(
                    VerifiedProtocol::admit(bytes),
                    Err(CompatibilityError::ProtocolVersion)
                ));
            }
        }
    }

    #[test]
    fn build_admission_retains_exact_single_inert_declaration_policy() {
        let declaration = format!("var buildUrl = \"{VERIFIED_BUILD}\";");
        for text in [
            declaration.clone(),
            format!("<script>\n{declaration}\n</script>"),
            // This is text matching, not a JavaScript parser or interpreter.
            format!("<!-- {declaration} -->"),
        ] {
            assert!(build(text.as_bytes()).is_ok());
            assert!(build(text.as_bytes()).is_ok());
        }
        for text in [
            String::new(),
            "var buildUrl = \"other\";".into(),
            format!("{declaration}{declaration}"),
            format!("{declaration}\n// var buildUrl"),
            format!("var buildUrl=\"{VERIFIED_BUILD}\";"),
        ] {
            assert!(matches!(
                build(text.as_bytes()),
                Err(CompatibilityError::GameBuild)
            ));
        }
        let mut invalid_utf8 = declaration.into_bytes();
        invalid_utf8.push(0xff);
        assert!(matches!(
            build(&invalid_utf8),
            Err(CompatibilityError::GameBuild)
        ));
    }

    #[test]
    fn dependent_admission_keeps_protocol_error_precedence_and_public_diagnostics() {
        let rejected = VerifiedProtocol::admit(b"9")
            .and_then(|protocol| protocol.admit_build(b"var buildUrl = \"other\";"));
        assert!(matches!(rejected, Err(CompatibilityError::ProtocolVersion)));
        assert_eq!(
            String::from(CompatibilityError::ProtocolVersion),
            "This server protocol version is not verified."
        );
        assert_eq!(
            String::from(CompatibilityError::GameBuild),
            "This game build is not verified."
        );
    }
}
