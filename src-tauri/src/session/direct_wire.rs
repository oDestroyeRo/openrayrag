//! Version-8 native authentication. Neither handshake nor optional token leaves native memory.
use crate::shared::domain_values::CharacterSlot;
const VERSION: i16 = 8;
pub(crate) fn authentication(
    credentials: &crate::session::login_logic::DirectCredentials,
) -> Vec<u8> {
    fn string(out: &mut Vec<u8>, value: &str) {
        let mut len = value.len();
        while len >= 128 {
            out.push((len as u8 & 127) | 128);
            len >>= 7;
        }
        out.push(len as u8);
        out.extend_from_slice(value.as_bytes());
    }
    let mut out = VERSION.to_le_bytes().to_vec();
    out.extend_from_slice(&[0, 0, 0]);
    string(&mut out, credentials.username());
    string(&mut out, credentials.password());
    out
}
struct Reader<'a> {
    bytes: &'a [u8],
    bit: usize,
}
impl Reader<'_> {
    fn bits(&mut self, count: usize) -> Result<u32, String> {
        if self.bit + count > self.bytes.len() * 8 {
            return Err("Truncated character approval.".into());
        }
        let mut value = 0;
        for i in 0..count {
            value |= u32::from((self.bytes[self.bit / 8] >> (self.bit % 8)) & 1) << i;
            self.bit += 1;
        }
        Ok(value)
    }
    fn skip(&mut self, count: usize) -> Result<(), String> {
        if count > 4096 || self.bit + count * 8 > self.bytes.len() * 8 {
            return Err("Invalid approval length.".into());
        }
        self.bit += count * 8;
        Ok(())
    }
    fn string(&mut self) -> Result<String, String> {
        let count = self.bits(16)? as usize;
        if count > 256 {
            return Err("Invalid character name length.".into());
        }
        let bytes: Vec<u8> = (0..count)
            .map(|_| self.bits(8).map(|v| v as u8))
            .collect::<Result<_, _>>()?;
        String::from_utf8(bytes).map_err(|_| "Invalid character name encoding.".into())
    }
}
pub(crate) fn selected_character(bytes: &[u8], chosen: CharacterSlot) -> Result<String, String> {
    if bytes.first() != Some(&0) || bytes.len() > 16_384 {
        return Err("Unknown character approval.".into());
    }
    let mut reader = Reader { bytes, bit: 8 };
    if reader.bits(1)? != 0 {
        let length = reader.bits(32)? as usize;
        reader.skip(length)?;
    }
    let count = reader.bits(32)?;
    if count > 3 {
        return Err("Unknown character count.".into());
    }
    let mut slots = [false; 3];
    let mut selected = None;
    for _ in 0..count {
        let name = reader.string()?;
        let slot = reader.bits(32)? as usize;
        reader.string()?;
        let length = reader.bits(32)? as usize;
        if name.is_empty() || name.chars().any(char::is_control) {
            return Err("Unknown character approval layout.".into());
        }
        let slot =
            CharacterSlot::try_from(slot).map_err(|_| "Unknown character approval layout.")?;
        if slots[slot.index()] || length > 256 || !length.is_multiple_of(4) {
            return Err("Unknown character approval layout.".into());
        }
        reader.skip(length)?;
        slots[slot.index()] = true;
        if slot == chosen {
            selected = Some(name);
        }
    }
    if bytes.len() * 8 - reader.bit >= 8 {
        return Err("Unknown approval trailer.".into());
    }
    selected.ok_or_else(|| {
        format!(
            "Character slot {} is empty. Choose an existing character.",
            chosen.index() + 1
        )
    })
}
pub(crate) fn enter(name: &str) -> Vec<u8> {
    let mut out = vec![3];
    let mut bit = 9;
    for (value, count) in [(name.len() as u32, 16)]
        .into_iter()
        .chain(name.bytes().map(|b| (u32::from(b), 8)))
    {
        for i in 0..count {
            let at = bit / 8;
            if at == out.len() {
                out.push(0);
            }
            out[at] |= (((value >> i) & 1) as u8) << (bit % 8);
            bit += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn authentication(username: &str, password: &str) -> Vec<u8> {
        let profile = crate::session::login_logic::LoginProfile {
            username: username.into(),
            password: password.into(),
            character_slot: 0,
            mode: crate::session::login_logic::ConnectionMode::BotOnly,
            auto_login: false,
        };
        super::authentication(&profile.try_into().unwrap())
    }
    fn selected_character(bytes: &[u8], chosen: u8) -> Result<String, String> {
        super::selected_character(
            bytes,
            CharacterSlot::try_from(chosen).map_err(|_| "Unknown character approval.")?,
        )
    }
    fn approval(names: &[(&str, u32)], token: bool) -> Vec<u8> {
        let mut out = vec![0];
        let mut bit = 8;
        let mut write = |value: u32, count: usize| {
            for i in 0..count {
                let at = bit / 8;
                if at == out.len() {
                    out.push(0);
                }
                out[at] |= (((value >> i) & 1) as u8) << (bit % 8);
                bit += 1;
            }
        };
        write(u32::from(token), 1);
        if token {
            write(2, 32);
            write(9, 8);
            write(10, 8);
        }
        write(names.len() as u32, 32);
        for (name, slot) in names {
            write(name.len() as u32, 16);
            for b in name.bytes() {
                write(u32::from(b), 8);
            }
            write(*slot, 32);
            write(0, 16);
            write(0, 32);
        }
        out
    }
    #[test]
    fn authentication_is_dotnet_binary_not_game_bitstream() {
        assert_eq!(authentication("a", "b"), [8, 0, 0, 0, 0, 1, 97, 1, 98]);
        assert_eq!(
            authentication("ก", "é"),
            [8, 0, 0, 0, 0, 3, 224, 184, 129, 2, 195, 169]
        );
        let bytes = authentication("a", &"x".repeat(128));
        assert_eq!(&bytes[7..9], &[128, 1]);
        assert_eq!(enter("A"), [3, 2, 0, 130, 0]);
    }
    #[test]
    fn approval_selects_server_name_and_discards_token_and_rejects_malformed() {
        assert_eq!(
            selected_character(&approval(&[("Server name", 0), ("Other", 2)], true), 0).unwrap(),
            "Server name"
        );
        assert!(selected_character(&approval(&[("Existing", 0)], false), 1)
            .unwrap_err()
            .contains("empty"));
        assert!(selected_character(&approval(&[("A", 0), ("B", 0)], false), 0).is_err());
        assert!(selected_character(&approval(&[("A", 3)], false), 0).is_err());
        assert!(selected_character(&[1], 0).is_err());
        assert!(selected_character(&[0, 255], 0).is_err());
        let bytes = approval(&[("ก", 0)], false);
        assert_eq!(selected_character(&bytes, 0).unwrap(), "ก");
        for n in 0..bytes.len() - 1 {
            assert!(selected_character(&bytes[..n], 0).is_err());
        }
    }
}
