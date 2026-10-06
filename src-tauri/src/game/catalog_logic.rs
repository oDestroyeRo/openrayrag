//! Immutable embedded navigation catalog queries, without runtime effects.
use std::sync::OnceLock;

fn navigation_maps() -> &'static serde_json::Map<String, serde_json::Value> {
    static MAPS: OnceLock<serde_json::Map<String, serde_json::Value>> = OnceLock::new();
    MAPS.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/data/navigation-maps.json"))
            .expect("Bundled navigation catalog must be valid")
    })
}
pub(crate) fn supported_map(map: &str) -> bool {
    navigation_maps().contains_key(map)
}
pub(crate) fn map_dimensions(map: &str) -> Option<(u64, u64)> {
    let grid = navigation_maps().get(map)?;
    Some((grid.get("width")?.as_u64()?, grid.get("height")?.as_u64()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_queries_preserve_supported_maps_and_dimensions() {
        assert!(supported_map("prontera"));
        let (width, height) = map_dimensions("prontera").unwrap();
        assert!(width > 0 && height > 0);
        assert!(!supported_map("unsupported-synthetic-map"));
        assert!(map_dimensions("unsupported-synthetic-map").is_none());
        assert!(!supported_map("PRONTERA"));
    }
}
