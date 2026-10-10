use crate::shared::domain_values::{Percentage, RecoveryTimeoutSeconds};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::hash::Hash;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    map: String,
    targets: Vec<u32>,
    radius: u8,
    // Compatibility sink for settings saved before the emergency cutoff was removed.
    #[serde(default, rename = "minHpPercent", skip_serializing)]
    _legacy_min_hp_percent: serde::de::IgnoredAny,
    loot: bool,
    #[serde(rename = "route_randomWalk")]
    route_random_walk: u8,
    #[serde(rename = "route_step")]
    route_step: u8,
    #[serde(rename = "route_avoidWalls")]
    route_avoid_walls: bool,
    #[serde(rename = "route_randomWalk_maxRouteTime")]
    route_random_walk_max_route_time: u16,
    attack_route_max_path_distance: u16,
    attack_max_route_time: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    automation: Option<AutomationSettings>,
}

/// Run admission has stricter rules than authoring/persisting a form. The raw
/// schema retains serde defaults; this borrowed domain view cannot deserialize
/// or reconstruct unchecked fields and lives through native script assembly.
#[derive(Serialize)]
#[serde(transparent)]
pub(crate) struct RunSettings<'a>(&'a Settings);

/// Non-replayable protection transferred only for the same continuing character.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LiveSettingsGuard {
    version: u8,
    pub(crate) character: String,
    items: Vec<ProtectedRecoveryItem>,
    hp: RecoveryProtection,
    sp: RecoveryProtection,
    cooldowns: Vec<RecoveryCooldown>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryProtection {
    min_stock: u16,
    cooldown_seconds: u16,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProtectedRecoveryItem {
    item_id: u32,
    min_stock: u16,
    cooldown_seconds: u16,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RecoveryCooldown {
    key: String,
    at: u64,
}
impl LiveSettingsGuard {
    pub(crate) fn validate_at(&self, at: u64) -> Result<(), String> {
        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        let valid_key = |key: &str| {
            key == "hp-potions"
                || key == "sp-potions"
                || key.strip_prefix("item:").is_some_and(|id| {
                    id.parse::<u32>().is_ok_and(|value| {
                        value > 0 && value <= i32::MAX as u32 && id == value.to_string()
                    })
                })
        };
        if self.version != 1
            || self.character.is_empty()
            || self.character.chars().count() > 64
            || self.character.chars().any(char::is_control)
            || self.items.len() > 256
            || self.items.iter().any(|item| {
                item.item_id == 0
                    || item.item_id > i32::MAX as u32
                    || item.min_stock > 9999
                    || item.cooldown_seconds > 3600
                    || !ids.insert(item.item_id)
            })
            || [&self.hp, &self.sp]
                .iter()
                .any(|row| row.min_stock > 9999 || row.cooldown_seconds > 3600)
            || self.cooldowns.len() > 256
            || self.cooldowns.iter().any(|row| {
                !valid_key(&row.key)
                    || row.at > at.min(9_007_199_254_740_991)
                    || !keys.insert(&row.key)
            })
        {
            return Err("Invalid live settings resource protection.".into());
        }
        Ok(())
    }
}
impl<'a> TryFrom<&'a Settings> for RunSettings<'a> {
    type Error = String;
    fn try_from(value: &'a Settings) -> Result<Self, Self::Error> {
        value.validate()?;
        Ok(Self(value))
    }
}

#[derive(Serialize)]
#[serde(transparent)]
pub(crate) struct DeathResume<'a>(&'a DeathRecoveryGuard);
impl<'a> TryFrom<&'a DeathRecoveryGuard> for DeathResume<'a> {
    type Error = String;
    fn try_from(value: &'a DeathRecoveryGuard) -> Result<Self, Self::Error> {
        value.validate()?;
        Ok(Self(value))
    }
}
#[derive(Serialize)]
#[serde(transparent)]
pub(crate) struct SupplyResume<'a>(&'a SupplyResumeGuard);
impl<'a> TryFrom<&'a SupplyResumeGuard> for SupplyResume<'a> {
    type Error = String;
    fn try_from(value: &'a SupplyResumeGuard) -> Result<Self, Self::Error> {
        value.validate()?;
        Ok(Self(value))
    }
}
#[derive(Serialize)]
#[serde(transparent)]
pub(crate) struct EscapeResume<'a>(&'a EscapeResumeGuard);
impl<'a> TryFrom<&'a EscapeResumeGuard> for EscapeResume<'a> {
    type Error = String;
    fn try_from(value: &'a EscapeResumeGuard) -> Result<Self, Self::Error> {
        value.validate()?;
        Ok(Self(value))
    }
}

impl Settings {
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.validate_for(false)
    }
    pub(crate) fn validate_form(&self) -> Result<(), String> {
        self.validate_for(true)
    }
    fn validate_for(&self, form: bool) -> Result<(), String> {
        if !(1..=20).contains(&self.radius)
            || !(form && self.map.is_empty()
                || crate::game::catalog_logic::supported_map(&self.map))
            || !map_code(&self.map, form)
            || !matches!(self.route_random_walk, 0 | 2)
            || !(1..=20).contains(&self.route_step)
            || !(1..=600).contains(&self.route_random_walk_max_route_time)
            || !(1..=200).contains(&self.attack_route_max_path_distance)
            || !(1..=60).contains(&self.attack_max_route_time)
            || self.targets.len() > 64
            || !unique_by(&self.targets, |id| *id)
            || self.targets.iter().any(|id| !positive_id(*id))
        {
            return Err("Invalid combat settings.".into());
        }
        let Some(automation) = &self.automation else {
            return if !form && self.targets.is_empty() {
                Err("Choose selected monsters.".into())
            } else {
                Ok(())
            };
        };
        automation.validate()?;
        if let Some(area) = automation
            .map_policy
            .as_ref()
            .and_then(|p| p.lock_area.as_ref())
        {
            if area.map != self.map
                || (!automation.travel.destination_map.is_empty()
                    && automation.travel.destination_map != self.map)
            {
                return Err("Field lock and destination maps must match.".into());
            }
        }
        if !form
            && self.targets.is_empty()
            && matches!(
                automation.combat.mode,
                CombatMode::Selected | CombatMode::Both
            )
            && !automation
                .combat
                .rules
                .iter()
                .any(|rule| rule.action == MonsterAction::Attack)
        {
            return Err("Choose selected monsters or disable selected combat.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationSettings {
    #[serde(
        default,
        deserialize_with = "deserialize_party_heal",
        skip_serializing_if = "Option::is_none"
    )]
    party_heal: Option<PartyHealSettings>,
    #[serde(default)]
    loadout: LoadoutSettings,
    combat: Combat,
    loot: Loot,
    recovery: Recovery,
    #[serde(default, skip_serializing_if = "Escape::is_default")]
    escape: Escape,
    #[serde(
        default,
        deserialize_with = "deserialize_recovery_items",
        skip_serializing_if = "Option::is_none"
    )]
    hp_potions: Option<RecoveryItemSettings>,
    #[serde(
        default,
        deserialize_with = "deserialize_recovery_items",
        skip_serializing_if = "Option::is_none"
    )]
    sp_potions: Option<RecoveryItemSettings>,
    items: Vec<ItemRule>,
    skills: Vec<SkillRule>,
    equipment: Vec<EquipmentRule>,
    #[serde(
        default,
        deserialize_with = "deserialize_attack_strategies",
        skip_serializing_if = "Option::is_none"
    )]
    attack_strategies: Option<Vec<AttackStrategyRule>>,
    #[serde(
        default,
        deserialize_with = "deserialize_retreat",
        skip_serializing_if = "Option::is_none"
    )]
    retreat: Option<RetreatSettings>,
    allocation: Allocation,
    follow: Follow,
    travel: Travel,
    limits: Limits,
    respawn: Respawn,
    schedule: Schedule,
    #[serde(
        default,
        deserialize_with = "deserialize_disposition",
        skip_serializing_if = "Option::is_none"
    )]
    disposition: Option<DispositionPolicy>,
    #[serde(
        default,
        deserialize_with = "deserialize_supply",
        skip_serializing_if = "Option::is_none"
    )]
    supply: Option<SupplySettings>,
    #[serde(
        default,
        deserialize_with = "deserialize_map_policy",
        skip_serializing_if = "Option::is_none"
    )]
    map_policy: Option<MapPolicy>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetreatSettings {
    enabled: bool,
    trigger_distance: u8,
    desired_distance: u8,
    max_path_steps: u8,
    max_attempts: u8,
}
fn deserialize_retreat<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RetreatSettings>, D::Error> {
    RetreatSettings::deserialize(deserializer).map(Some)
}
impl RetreatSettings {
    fn valid(&self) -> bool {
        (1..=13).contains(&self.trigger_distance)
            && (2..=14).contains(&self.desired_distance)
            && self.desired_distance > self.trigger_distance
            && (1..=20).contains(&self.max_path_steps)
            && (1..=10).contains(&self.max_attempts)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MapPolicy {
    mode: String,
    allow: Vec<String>,
    deny: Vec<String>,
    penalties: Vec<MapPenalty>,
    lock_area: Option<LockArea>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MapPenalty {
    map: String,
    cost: f64,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LockArea {
    map: String,
    min_x: u16,
    min_y: u16,
    max_x: u16,
    max_y: u16,
}
fn deserialize_map_policy<'de, D>(deserializer: D) -> Result<Option<MapPolicy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    {
        let value = Value::deserialize(deserializer)?;
        validate_map_policy(&value).map_err(serde::de::Error::custom)?;
        serde_json::from_value(value)
            .map(Some)
            .map_err(serde::de::Error::custom)
    }
}
impl MapPolicy {
    fn valid(&self) -> bool {
        let list = |v: &Vec<String>| {
            v.len() <= 256
                && unique_by(v, |m| m.clone())
                && v.iter()
                    .all(|m| crate::game::catalog_logic::supported_map(m))
        };
        matches!(self.mode.as_str(), "legacy" | "weighted")
            && list(&self.allow)
            && list(&self.deny)
            && self.penalties.len() <= 256
            && unique_by(&self.penalties, |p| p.map.clone())
            && self.penalties.iter().all(|p| {
                crate::game::catalog_logic::supported_map(&p.map)
                    && p.cost.is_finite()
                    && (0.0..=1_000_000.0).contains(&p.cost)
            })
            && self.lock_area.as_ref().is_none_or(|a| {
                crate::game::catalog_logic::map_dimensions(&a.map).is_some_and(|(w, h)| {
                    a.min_x <= a.max_x
                        && a.min_y <= a.max_y
                        && u64::from(a.max_x) < w
                        && u64::from(a.max_y) < h
                })
            })
    }
}
pub(crate) fn validate_map_policy(value: &Value) -> Result<(), String> {
    // serde treats an omitted Option as None; require the explicit nullable field.
    if !value
        .as_object()
        .is_some_and(|o| o.contains_key("lockArea"))
    {
        return Err("Invalid map policy.".into());
    }
    let policy: MapPolicy =
        serde_json::from_value(value.clone()).map_err(|_| "Invalid map policy.")?;
    if policy.valid() {
        Ok(())
    } else {
        Err("Invalid map policy.".into())
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispositionPolicy {
    max_spend: u32,
    rules: Vec<DispositionRule>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SupplySettings {
    enabled: bool,
    stock_enabled: bool,
    weight_enabled: bool,
    #[serde(default)]
    sell_all_permitted: bool,
    weight_start_percent: u8,
    weight_end_percent: u8,
    minimum_interval_seconds: u32,
    max_trips: u8,
    max_actions: u16,
    max_duration_seconds: u16,
    max_spend: u32,
    storage_service: String,
    buy_service: String,
    sell_service: String,
    #[serde(default = "default_supply_merchant")]
    merchant_mode: String,
    #[serde(default = "default_supply_transport")]
    transport: String,
    #[serde(default)]
    save_map: String,
    #[serde(default = "default_supply_reserve")]
    return_min_stock: u16,
}
fn default_supply_merchant() -> String {
    "manual".into()
}
fn default_supply_transport() -> String {
    "travel".into()
}
fn default_supply_reserve() -> u16 {
    1
}
fn deserialize_supply<'de, D>(deserializer: D) -> Result<Option<SupplySettings>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    SupplySettings::deserialize(deserializer).map(Some)
}
impl SupplySettings {
    fn valid(&self) -> bool {
        let contract = |id: &str| {
            id.len() <= 128
                && id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        };
        (!self.enabled || self.stock_enabled || self.weight_enabled)
            && (1..=100).contains(&self.weight_start_percent)
            && self.weight_end_percent > 0
            && self.weight_end_percent < self.weight_start_percent
            && (1..=86400).contains(&self.minimum_interval_seconds)
            && self.max_trips <= 100
            && (1..=1000).contains(&self.max_actions)
            && (30..=3600).contains(&self.max_duration_seconds)
            && self.max_spend <= 2_000_000_000
            && contract(&self.storage_service)
            && contract(&self.buy_service)
            && contract(&self.sell_service)
            && matches!(self.merchant_mode.as_str(), "manual" | "automatic")
            && matches!(
                self.transport.as_str(),
                "travel" | "butterfly" | "returnSkill"
            )
            && map_code(&self.save_map, true)
            && self.return_min_stock <= 9999
            && (!self.enabled || self.transport == "travel" || !self.save_map.is_empty())
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeathRecoveryGuard {
    version: u8,
    character: String,
    destination: String,
    phase: String,
    uncertain: bool,
    recovery_seconds: u16,
    return_seconds: u16,
    recovery_deadline: u64,
    return_deadline: u64,
}
impl DeathRecoveryGuard {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version == 1
            && self
                .character
                .chars()
                .any(|c| !c.is_whitespace() && c != '\u{feff}')
            && self.character.encode_utf16().count() <= 64
            && !self
                .character
                .chars()
                .any(|c| c <= '\u{001f}' || c == '\u{007f}')
            && map_code(&self.destination, false)
            && matches!(
                self.phase.as_str(),
                "revival" | "recovery" | "return" | "failed"
            )
            && (self.phase != "recovery" || self.recovery_deadline > 0)
            && (self.phase != "return" || self.return_deadline > 0)
            && self.recovery_seconds <= 3600
            && self.return_seconds <= 1200
            && self.recovery_deadline <= 8_640_000_000_000_000
            && self.return_deadline <= 8_640_000_000_000_000
        {
            Ok(())
        } else {
            Err("Invalid death recovery state.".into())
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SupplyResumeGuard {
    version: u8,
    character: String,
    latched: bool,
    remaining_trips: i16,
    #[serde(default)]
    trip_sequence: u64,
    actions: u16,
    spent: u32,
    reserved: u32,
    interval_seconds: u32,
    deadline_seconds: u16,
    interrupted: bool,
    uncertain: bool,
    #[serde(deserialize_with = "deserialize_supply_destination")]
    return_destination: Option<SupplyDestination>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SupplyDestination {
    map: String,
    position: SupplyPosition,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SupplyPosition {
    x: u16,
    y: u16,
}
fn deserialize_supply_destination<'de, D>(
    deserializer: D,
) -> Result<Option<SupplyDestination>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<SupplyDestination>::deserialize(deserializer)
}
impl SupplyResumeGuard {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.version == 1
            && !self.character.trim().is_empty()
            && self.character.encode_utf16().count() <= 64
            && !self
                .character
                .chars()
                .any(|c| c <= '\u{001f}' || c == '\u{007f}')
            && (-1..=100).contains(&self.remaining_trips)
            && self.trip_sequence <= 9_007_199_254_740_991
            && self.actions <= 1000
            && self.spent <= 2_000_000_000
            && self.reserved <= 2_000_000_000
            && self.interval_seconds <= 86400
            && self.deadline_seconds <= 3600
            && self.return_destination.as_ref().is_none_or(|d| {
                map_code(&d.map, false) && d.position.x <= 511 && d.position.y <= 511
            })
        {
            Ok(())
        } else {
            Err("Invalid supply resume state.".into())
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DispositionRule {
    item_id: u32,
    keep: u16,
    minimum: u16,
    desired: u16,
    maximum: u16,
    store: bool,
    sell: bool,
    cart: bool,
    restock: Restock,
    allow_unique: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum Restock {
    Off,
    Storage,
    Cart,
    Buy,
}

impl<'de> Deserialize<'de> for Restock {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "off" => Ok(Self::Off),
            "storage" => Ok(Self::Storage),
            "cart" => Ok(Self::Cart),
            "buy" => Ok(Self::Buy),
            _ => Err(serde::de::Error::custom("Invalid restock mode.")),
        }
    }
}

fn deserialize_disposition<'de, D>(deserializer: D) -> Result<Option<DispositionPolicy>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    DispositionPolicy::deserialize(deserializer).map(Some)
}

impl DispositionPolicy {
    fn valid(&self) -> bool {
        self.max_spend <= 2_000_000_000
            && self.rules.len() <= 128
            && unique_by(&self.rules, |rule| rule.item_id)
            && self.rules.iter().all(|rule| {
                positive_id(rule.item_id)
                    && rule.keep <= rule.minimum
                    && rule.minimum <= rule.desired
                    && rule.desired <= rule.maximum
                    && rule.maximum <= 32767
            })
    }
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Escape {
    enabled: bool,
    #[serde(
        default = "escape_hp_enabled",
        skip_serializing_if = "escape_hp_is_default"
    )]
    hp_enabled: bool,
    #[serde(default, skip_serializing_if = "escape_threat_is_disabled")]
    threat_enabled: bool,
    #[serde(
        default = "escape_threat_count",
        skip_serializing_if = "escape_count_is_default"
    )]
    threat_count: u8,
    #[serde(
        default = "escape_threat_window",
        skip_serializing_if = "escape_window_is_default"
    )]
    threat_window_seconds: u8,
    hp_below_percent: u8,
    mode: EscapeMode,
    method: EscapeMethod,
    min_stock: u16,
    cooldown_seconds: u16,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum EscapeMode {
    Random,
    Save,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum EscapeMethod {
    Item,
    Skill,
}

fn escape_hp_is_default(value: &bool) -> bool {
    *value
}
fn escape_threat_is_disabled(value: &bool) -> bool {
    !*value
}
fn escape_count_is_default(value: &u8) -> bool {
    *value == escape_threat_count()
}
fn escape_window_is_default(value: &u8) -> bool {
    *value == escape_threat_window()
}
fn escape_hp_enabled() -> bool {
    true
}
fn escape_threat_count() -> u8 {
    3
}
fn escape_threat_window() -> u8 {
    10
}
impl Default for Escape {
    fn default() -> Self {
        Self {
            enabled: false,
            hp_below_percent: 20,
            hp_enabled: true,
            threat_enabled: false,
            threat_count: 3,
            threat_window_seconds: 10,
            mode: EscapeMode::Random,
            method: EscapeMethod::Item,
            min_stock: 0,
            cooldown_seconds: 60,
        }
    }
}
impl Escape {
    fn is_default(&self) -> bool {
        self == &Self::default()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct EscapeResumeGuard {
    cooldown_seconds: u16,
    latched: bool,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_escape_recovery"
    )]
    recovery: Option<EscapeRecovery>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EscapeRecovery {
    hp_percent: u8,
    threat_count: u8,
    quiet_seconds: u8,
}
fn deserialize_escape_recovery<'de, D>(deserializer: D) -> Result<Option<EscapeRecovery>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    EscapeRecovery::deserialize(deserializer).map(Some)
}
impl EscapeResumeGuard {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.cooldown_seconds <= 3600
            && self.recovery.as_ref().is_none_or(|r| {
                (1..=100).contains(&r.hp_percent)
                    && r.threat_count <= 64
                    && r.quiet_seconds <= 60
                    && if r.threat_count == 0 {
                        r.quiet_seconds == 0
                    } else {
                        r.quiet_seconds >= 1
                    }
            })
        {
            Ok(())
        } else {
            Err("Invalid escape resume guard.".into())
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LoadoutSettings {
    enabled: bool,
    auto_ammo: bool,
    min_ammo_stock: u16,
    ammo_preferences: Vec<AmmoPreference>,
    restore: RestorePolicy,
    cooldown_seconds: u16,
}
impl Default for LoadoutSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            auto_ammo: true,
            min_ammo_stock: 0,
            ammo_preferences: vec![],
            restore: RestorePolicy::ConditionEnd,
            cooldown_seconds: 3,
        }
    }
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AmmoPreference {
    item_id: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
enum RestorePolicy {
    ConditionEnd,
    Never,
}
impl<'de> Deserialize<'de> for RestorePolicy {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "conditionEnd" => Ok(Self::ConditionEnd),
            "never" => Ok(Self::Never),
            _ => Err(serde::de::Error::custom(
                "Invalid loadout restoration policy.",
            )),
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Combat {
    mode: CombatMode,
    level_difference: i16,
    #[serde(
        default,
        deserialize_with = "deserialize_party_engagement",
        skip_serializing_if = "Option::is_none"
    )]
    party_engagement: Option<bool>,
    rules: Vec<MonsterRule>,
}

fn deserialize_party_engagement<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<bool>, D::Error> {
    bool::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CombatMode {
    Off,
    Selected,
    Retaliate,
    Both,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum MonsterAction {
    Attack,
    Ignore,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MonsterRule {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_conditions"
    )]
    conditions: Option<Vec<Value>>,
    class_id: u32,
    action: MonsterAction,
    priority: i16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Loot {
    ownership: Ownership,
    default_action: LootAction,
    rules: Vec<LootRule>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Ownership {
    Own,
    All,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum LootAction {
    Pickup,
    Ignore,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LootRule {
    item_id: u32,
    action: LootAction,
    priority: i16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recovery {
    enabled: bool,
    hp_start: u8,
    hp_end: u8,
    sp_start: u8,
    sp_end: u8,
    timeout_seconds: u16,
}
#[derive(Debug)]
struct RecoveryBounds {
    hp_start: Percentage,
    hp_end: Percentage,
    sp_start: Percentage,
    sp_end: Percentage,
    _timeout: RecoveryTimeoutSeconds,
}

#[derive(Debug)]
enum RecoveryError {
    Bounds,
    Hysteresis,
}
// A policy is constructed only after both range and cross-field checks; no
// unchecked deserialization can rebuild an inverted hysteresis pair.
struct RecoveryPolicy;

fn recovery_percentage(
    value: u8,
    min: u8,
    max: u8,
    field: &'static str,
) -> Result<Percentage, &'static str> {
    if !(min..=max).contains(&value) {
        return Err(field);
    }
    Percentage::try_from(value).map_err(|_| field)
}

impl Recovery {
    fn validated_bounds(&self) -> Result<RecoveryBounds, Vec<&'static str>> {
        match (
            recovery_percentage(self.hp_start, 1, 95, "hpStart"),
            recovery_percentage(self.hp_end, 2, 100, "hpEnd"),
            recovery_percentage(self.sp_start, 0, 95, "spStart"),
            recovery_percentage(self.sp_end, 1, 100, "spEnd"),
            RecoveryTimeoutSeconds::try_from(self.timeout_seconds).map_err(|_| "timeoutSeconds"),
        ) {
            (Ok(hp_start), Ok(hp_end), Ok(sp_start), Ok(sp_end), Ok(timeout)) => {
                Ok(RecoveryBounds {
                    hp_start,
                    hp_end,
                    sp_start,
                    sp_end,
                    _timeout: timeout,
                })
            }
            (hp_start, hp_end, sp_start, sp_end, timeout) => Err([
                hp_start.err(),
                hp_end.err(),
                sp_start.err(),
                sp_end.err(),
                timeout.err(),
            ]
            .into_iter()
            .flatten()
            .collect()),
        }
    }
    fn policy(&self) -> Result<RecoveryPolicy, RecoveryError> {
        let bounds = self.validated_bounds().map_err(|_| RecoveryError::Bounds)?;
        if bounds.hp_start >= bounds.hp_end || bounds.sp_start >= bounds.sp_end {
            return Err(RecoveryError::Hysteresis);
        }
        Ok(RecoveryPolicy)
    }
    fn valid(&self) -> bool {
        self.policy().is_ok()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemRule {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_conditions"
    )]
    conditions: Option<Vec<Value>>,
    item_id: u32,
    resource: Resource,
    below_percent: u8,
    min_stock: u16,
    cooldown_seconds: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecoveryItemSettings {
    mode: RecoveryItemMode,
    item_ids: Vec<u32>,
    below_percent: u8,
    min_stock: u16,
    cooldown_seconds: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum RecoveryItemMode {
    Off,
    Any,
    Selected,
}

impl<'de> Deserialize<'de> for RecoveryItemMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "off" => Ok(Self::Off),
            "any" => Ok(Self::Any),
            "selected" => Ok(Self::Selected),
            _ => Err(serde::de::Error::custom("Invalid recovery item mode.")),
        }
    }
}

fn deserialize_recovery_items<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<RecoveryItemSettings>, D::Error> {
    RecoveryItemSettings::deserialize(deserializer).map(Some)
}

fn recovery_item_ids(resource: Resource) -> &'static [u32] {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Catalog {
        hp_ids: Vec<u32>,
        sp_ids: Vec<u32>,
    }
    static CATALOG: std::sync::OnceLock<Catalog> = std::sync::OnceLock::new();
    let catalog = CATALOG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../src/data/recovery-item-catalog.json"))
            .expect("The bundled recovery item catalog must be valid.")
    });
    match resource {
        Resource::Hp => &catalog.hp_ids,
        Resource::Sp => &catalog.sp_ids,
    }
}

impl RecoveryItemSettings {
    fn valid(&self, resource: Resource) -> bool {
        let min_cooldown = match resource {
            Resource::Hp => 0,
            Resource::Sp => 1,
        };
        let known_ids = recovery_item_ids(resource);
        (1..=100).contains(&self.below_percent)
            && self.min_stock <= 9999
            && (min_cooldown..=3600).contains(&self.cooldown_seconds)
            && self.item_ids.len() <= known_ids.len()
            && unique_by(&self.item_ids, |id| *id)
            && self.item_ids.iter().all(|id| known_ids.contains(id))
            && (!matches!(self.mode, RecoveryItemMode::Selected) || !self.item_ids.is_empty())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Resource {
    Hp,
    Sp,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillRule {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_conditions"
    )]
    conditions: Option<Vec<Value>>,
    skill_id: u16,
    level: u8,
    target: SkillTarget,
    hp_below_percent: u8,
    sp_above_percent: u8,
    cooldown_seconds: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum SkillTarget {
    #[serde(rename = "self")]
    Self_,
    Enemy,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AttackStrategyRule {
    id: String,
    species_ids: Vec<u32>,
    skill_id: u8,
    level: u8,
    behavior: AttackStrategyBehavior,
    max_attempts: u8,
    max_uses: u8,
    cooldown_seconds: u16,
    #[serde(
        default,
        deserialize_with = "deserialize_conditions",
        skip_serializing_if = "Option::is_none"
    )]
    conditions: Option<Vec<Value>>,
}
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PartyHealSettings {
    enabled: bool,
    level: i32,
    hp_below_percent: i32,
    sp_reserve: i32,
    cooldown_seconds: i32,
    max_attempts: i32,
}
fn deserialize_party_heal<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<PartyHealSettings>, D::Error> {
    PartyHealSettings::deserialize(d).map(Some)
}
impl PartyHealSettings {
    fn valid(&self) -> bool {
        (1..=10).contains(&self.level)
            && (1..=100).contains(&self.hp_below_percent)
            && self.sp_reserve >= 0
            && (1..=3600).contains(&self.cooldown_seconds)
            && (1..=100).contains(&self.max_attempts)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
enum AttackStrategyBehavior {
    Opener,
    Repeat,
}
impl<'de> Deserialize<'de> for AttackStrategyBehavior {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match String::deserialize(deserializer)?.as_str() {
            "opener" => Ok(Self::Opener),
            "repeat" => Ok(Self::Repeat),
            _ => Err(serde::de::Error::custom(
                "Invalid attack strategy behavior.",
            )),
        }
    }
}
fn deserialize_attack_strategies<'de, D>(
    deserializer: D,
) -> Result<Option<Vec<AttackStrategyRule>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Vec::<AttackStrategyRule>::deserialize(deserializer).map(Some)
}
impl AttackStrategyRule {
    fn valid(&self) -> bool {
        !self.id.is_empty()
            && self.id.len() <= 48
            && self
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            && !self.species_ids.is_empty()
            && self.species_ids.len() <= 64
            && unique_by(&self.species_ids, |id| *id)
            && self.species_ids.iter().all(|id| positive_id(*id))
            && matches!(self.skill_id, 11 | 12 | 16)
            && (1..=10).contains(&self.level)
            && (1..=100).contains(&self.max_attempts)
            && (1..=self.max_attempts).contains(&self.max_uses)
            && (1..=3600).contains(&self.cooldown_seconds)
            && conditions_valid(&self.conditions, false)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EquipmentRule {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_conditions"
    )]
    conditions: Option<Vec<Value>>,
    item_id: u32,
    hp_below_percent: u8,
    monster_class_id: u32,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Allocation {
    stats: Vec<StatAllocation>,
    skills: Vec<SkillAllocation>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct StatAllocation {
    stat: u8,
    target: u8,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SkillAllocation {
    skill_id: u16,
    target: u8,
}

fn deserialize_follow_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Follow {
    #[serde(
        default,
        deserialize_with = "deserialize_follow_value",
        skip_serializing_if = "Option::is_none"
    )]
    mode: Option<String>,
    #[serde(
        default,
        deserialize_with = "deserialize_follow_value",
        skip_serializing_if = "Option::is_none"
    )]
    rendezvous: Option<bool>,
    name: String,
    distance: u8,
    lost_seconds: u8,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Travel {
    destination_map: String,
    return_to_lock_map: bool,
    waypoints: Vec<Waypoint>,
    r#loop: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Waypoint {
    map: String,
    x: u16,
    y: u16,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    minutes: u16,
    kills: u32,
    pickups: u32,
    weight_percent: u8,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Respawn {
    enabled: bool,
    max_deaths: u8,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Schedule {
    enabled: bool,
    start_hour: u8,
    end_hour: u8,
}

fn deserialize_conditions<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<Value>>, D::Error> {
    Vec::<Value>::deserialize(deserializer).map(Some)
}
fn conditions_valid(conditions: &Option<Vec<Value>>, allow_candidate: bool) -> bool {
    conditions.as_ref().is_none_or(|values| {
        values.len() <= 16
            && values.iter().all(|value| {
                crate::game::control::validate_actor_predicate_for(value, allow_candidate).is_ok()
            })
    })
}

fn positive_id(id: u32) -> bool {
    (1..=i32::MAX as u32).contains(&id)
}

fn map_code(map: &str, empty: bool) -> bool {
    (empty && map.is_empty())
        || (!map.is_empty()
            && map.len() <= 64
            && map
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'))
}

fn unique_by<T, K: Eq + Hash>(items: &[T], key: impl Fn(&T) -> K) -> bool {
    let mut keys = HashSet::with_capacity(items.len());
    items.iter().all(|item| keys.insert(key(item)))
}

impl AutomationSettings {
    fn validate(&self) -> Result<(), String> {
        let valid = self
            .party_heal
            .as_ref()
            .is_none_or(PartyHealSettings::valid)
            && self.attack_strategies.as_ref().is_none_or(|rules| {
                rules.len() <= 32
                    && unique_by(rules, |rule| rule.id.clone())
                    && rules.iter().all(AttackStrategyRule::valid)
            })
            && (-100..=100).contains(&self.combat.level_difference)
            && self.combat.rules.len() <= 64
            && unique_by(&self.combat.rules, |r| r.class_id)
            && self.combat.rules.iter().all(|r| {
                positive_id(r.class_id)
                    && (-100..=100).contains(&r.priority)
                    && conditions_valid(&r.conditions, true)
            })
            && self.loot.rules.len() <= 128
            && unique_by(&self.loot.rules, |r| r.item_id)
            && self
                .loot
                .rules
                .iter()
                .all(|r| positive_id(r.item_id) && (-100..=100).contains(&r.priority))
            && self.recovery.valid()
            && (1..=64).contains(&self.escape.threat_count)
            && (1..=60).contains(&self.escape.threat_window_seconds)
            && (1..=95).contains(&self.escape.hp_below_percent)
            && self.escape.min_stock <= 9999
            && (1..=3600).contains(&self.escape.cooldown_seconds)
            && self
                .hp_potions
                .as_ref()
                .is_none_or(|policy| policy.valid(Resource::Hp))
            && self
                .sp_potions
                .as_ref()
                .is_none_or(|policy| policy.valid(Resource::Sp))
            && self.items.len() <= 32
            && unique_by(&self.items, |r| r.item_id)
            && self.items.iter().all(|r| {
                positive_id(r.item_id)
                    && conditions_valid(&r.conditions, false)
                    && (1..=100).contains(&r.below_percent)
                    && r.min_stock <= 9999
                    && (1..=3600).contains(&r.cooldown_seconds)
            })
            && self.skills.len() <= 32
            && unique_by(&self.skills, |r| r.skill_id)
            && self.skills.iter().all(|r| {
                (1..=255).contains(&r.skill_id)
                    && r.skill_id != 55
                    && conditions_valid(&r.conditions, false)
                    && (1..=10).contains(&r.level)
                    && (1..=100).contains(&r.hp_below_percent)
                    && r.sp_above_percent <= 100
                    && (1..=3600).contains(&r.cooldown_seconds)
            })
            && self.loadout.min_ammo_stock <= 9999
            && (1..=3600).contains(&self.loadout.cooldown_seconds)
            && self.loadout.ammo_preferences.len() <= 40
            && unique_by(&self.loadout.ammo_preferences, |r| r.item_id)
            && self
                .loadout
                .ammo_preferences
                .iter()
                .all(|r| positive_id(r.item_id))
            && self.equipment.len() <= 32
            && unique_by(&self.equipment, |r| r.item_id)
            && self.equipment.iter().all(|r| {
                positive_id(r.item_id)
                    && conditions_valid(&r.conditions, false)
                    && (1..=100).contains(&r.hp_below_percent)
                    && r.monster_class_id <= i32::MAX as u32
            })
            && self.allocation.stats.len() <= 6
            && unique_by(&self.allocation.stats, |r| r.stat)
            && self
                .allocation
                .stats
                .iter()
                .all(|r| r.stat <= 5 && (1..=99).contains(&r.target))
            && self.allocation.skills.len() <= 64
            && unique_by(&self.allocation.skills, |r| r.skill_id)
            && self
                .allocation
                .skills
                .iter()
                .all(|r| (1..=255).contains(&r.skill_id) && (1..=10).contains(&r.target))
            && self
                .follow
                .mode
                .as_deref()
                .is_none_or(|mode| matches!(mode, "name" | "partyLeader"))
            && (self.follow.mode.as_deref() != Some("partyLeader") || self.follow.name.is_empty())
            && (self.follow.rendezvous != Some(true)
                || self.follow.mode.as_deref() == Some("partyLeader"))
            && self.follow.name.encode_utf16().count() <= 48
            && !self.follow.name.chars().any(|c| c <= '\u{001f}')
            && (1..=20).contains(&self.follow.distance)
            && (1..=120).contains(&self.follow.lost_seconds)
            && map_code(&self.travel.destination_map, true)
            && self.travel.waypoints.len() <= 64
            && self
                .travel
                .waypoints
                .iter()
                .all(|p| map_code(&p.map, false) && p.x <= 511 && p.y <= 511)
            && self.limits.minutes <= 1440
            && self.limits.kills <= 1_000_000
            && self.limits.pickups <= 1_000_000
            && self.limits.weight_percent <= 100
            && self.respawn.max_deaths <= 100
            && self.schedule.start_hour <= 23
            && self.schedule.end_hour <= 23;
        let valid = valid
            && self
                .disposition
                .as_ref()
                .is_none_or(DispositionPolicy::valid)
            && self.supply.as_ref().is_none_or(SupplySettings::valid)
            && self.map_policy.as_ref().is_none_or(MapPolicy::valid)
            && self.retreat.as_ref().is_none_or(RetreatSettings::valid);
        if valid {
            Ok(())
        } else {
            Err("Invalid automation settings.".into())
        }
    }
}

/// Validate a manual resource preview's visible policy without starting a run.
pub(crate) fn validate_manual_protection_policy(value: &Value) -> Result<(), String> {
    let policy: AutomationSettings = serde_json::from_value(value.clone())
        .map_err(|_| "Invalid manual protection policy.".to_string())?;
    policy.validate()
}

#[cfg(test)]
mod tests {
    use super::{
        Escape, EscapeResume, EscapeResumeGuard, Recovery, RunSettings, Settings, SupplyResume,
        SupplyResumeGuard, SupplySettings,
    };
    use serde_json::{json, Value};

    #[test]
    fn recovery_accumulates_scalar_failures_before_checking_hysteresis() {
        let malformed = Recovery {
            enabled: true,
            hp_start: 0,
            hp_end: 101,
            sp_start: 96,
            sp_end: 0,
            timeout_seconds: 3601,
        };
        assert_eq!(
            malformed.validated_bounds().unwrap_err(),
            ["hpStart", "hpEnd", "spStart", "spEnd", "timeoutSeconds"]
        );
        assert!(!malformed.valid());

        for (hp_start, hp_end, sp_start, sp_end, timeout_seconds) in
            [(1, 2, 0, 1, 1), (95, 100, 95, 100, 3600)]
        {
            let mut recovery = Recovery {
                enabled: true,
                hp_start,
                hp_end,
                sp_start,
                sp_end,
                timeout_seconds,
            };
            assert!(recovery.valid());
            recovery.hp_end = recovery.hp_start;
            assert!(!recovery.valid());
            recovery.hp_end = hp_end;
            recovery.sp_end = recovery.sp_start;
            assert!(!recovery.valid());
        }
    }

    #[test]
    fn shares_strict_optional_party_engagement_settings() {
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../../src/data/party-engagement-settings-cases.json"
        ))
        .unwrap();
        for case in cases {
            let mut value = settings();
            value["automation"] = automation();
            for (key, setting) in case["value"].as_object().unwrap() {
                value["automation"]["combat"][key] = setting.clone();
            }
            let accepted = serde_json::from_value::<Settings>(value.clone())
                .map(|settings| settings.validate().is_ok())
                .unwrap_or(false);
            assert_eq!(
                accepted,
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if accepted {
                let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(
                    serde_json::to_value(parsed).unwrap()["automation"]["combat"],
                    value["automation"]["combat"]
                );
            }
        }
    }

    #[test]
    fn validates_non_replayable_live_settings_protection() {
        let value = json!({"version":1,"character":"Synthetic","items":[{"itemId":501,"minStock":3,"cooldownSeconds":60}],
            "hp":{"minStock":3,"cooldownSeconds":60},"sp":{"minStock":0,"cooldownSeconds":0},
            "cooldowns":[{"key":"item:501","at":1000},{"key":"hp-potions","at":1000}]});
        let parsed: super::LiveSettingsGuard = serde_json::from_value(value.clone()).unwrap();
        assert!(parsed.validate_at(1000).is_ok());
        for (pointer, invalid) in [
            ("/items/0/itemId", json!(0)),
            ("/items/0/minStock", json!(10000)),
            ("/hp/cooldownSeconds", json!(3601)),
            ("/cooldowns/0/key", json!("item:2147483648")),
            ("/cooldowns/0/at", json!(1001)),
        ] {
            let mut changed = value.clone();
            *changed.pointer_mut(pointer).unwrap() = invalid;
            let guard: super::LiveSettingsGuard = serde_json::from_value(changed).unwrap();
            assert!(guard.validate_at(1000).is_err(), "{pointer}");
        }
        let mut unknown = value;
        unknown["action"] = json!("useItem");
        assert!(serde_json::from_value::<super::LiveSettingsGuard>(unknown).is_err());
    }

    fn settings() -> Value {
        json!({
            "map": "prt_fild08", "targets": [4000], "radius": 12,
            "loot": true, "route_randomWalk": 0,
            "route_step": 10, "route_avoidWalls": true,
            "route_randomWalk_maxRouteTime": 75,
            "attackRouteMaxPathDistance": 20, "attackMaxRouteTime": 4
        })
    }

    #[test]
    fn run_admission_preserves_json_and_rejects_an_authoring_only_form() {
        let playable: Settings = serde_json::from_value(settings()).unwrap();
        let admitted = RunSettings::try_from(&playable).unwrap();
        assert_eq!(
            serde_json::to_value(&admitted).unwrap(),
            serde_json::to_value(&playable).unwrap()
        );
        let mut draft = settings();
        draft["map"] = "".into();
        draft["targets"] = json!([]);
        let draft: Settings = serde_json::from_value(draft).unwrap();
        assert!(draft.validate_form().is_ok());
        assert!(RunSettings::try_from(&draft).is_err());
    }

    fn automation() -> Value {
        json!({
            "combat": {"mode": "selected", "levelDifference": 1, "rules": []},
            "loot": {"ownership": "own", "defaultAction": "pickup", "rules": []},
            "recovery": {"enabled": false, "hpStart": 60, "hpEnd": 85, "spStart": 10, "spEnd": 80, "timeoutSeconds": 300},
            "loadout": {"enabled":false,"autoAmmo":true,"minAmmoStock":0,"ammoPreferences":[],"restore":"conditionEnd","cooldownSeconds":3},
            "items": [], "skills": [], "equipment": [],
            "allocation": {"stats": [], "skills": []},
            "follow": {"name": "", "distance": 4, "lostSeconds": 10},
            "travel": {"destinationMap": "", "returnToLockMap": false, "waypoints": [], "loop": false},
            "limits": {"minutes": 0, "kills": 0, "pickups": 0, "weightPercent": 0},
            "respawn": {"enabled": false, "maxDeaths": 1},
            "schedule": {"enabled": false, "startHour": 0, "endHour": 0}
        })
    }

    fn valid(value: Value) -> bool {
        serde_json::from_value::<Settings>(value).is_ok_and(|settings| settings.validate().is_ok())
    }

    #[test]
    fn optional_retreat_shared_contract() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/data/retreat-cases.json")).unwrap();
        for case in cases {
            let mut value = settings();
            value["automation"] = automation();
            value["automation"]["retreat"] = case["policy"].clone();
            assert_eq!(
                valid(value.clone()),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            if case["valid"] == true {
                let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            }
        }
        let mut old = settings();
        old["automation"] = automation();
        let parsed: Settings = serde_json::from_value(old.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), old);
    }

    #[test]
    fn party_follow_policy_matches_typescript_and_preserves_legacy() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../../src/data/party-follow-settings-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            let mut value = settings();
            value["automation"] = automation();
            value["automation"]["follow"] = case["follow"].clone();
            assert_eq!(
                valid(value.clone()),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["follow"]
            );
            if case["valid"] == true {
                let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(
                    serde_json::to_value(parsed).unwrap()["automation"]["follow"],
                    value["automation"]["follow"]
                );
            }
        }
    }

    #[test]
    fn preserves_existing_loot_scope_and_master_settings() {
        for ownership in ["own", "all"] {
            for enabled in [false, true] {
                let mut value = settings();
                value["loot"] = json!(enabled);
                value["automation"] = automation();
                value["automation"]["loot"]["ownership"] = json!(ownership);
                assert!(valid(value.clone()));
                let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            }
        }
        let mut invalid = settings();
        invalid["automation"] = automation();
        invalid["automation"]["loot"]["ownership"] = json!("unverified");
        assert!(!valid(invalid.clone()));
        invalid["automation"]["loot"]["ownership"] = json!("own");
        invalid["automation"]["loot"]["lootAll"] = json!(true);
        assert!(!valid(invalid));
    }

    #[test]
    fn party_heal_shared_schema_round_trip_and_bounds() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/data/party-heal-cases.json")).unwrap();
        for case in cases {
            let mut value = settings();
            value["automation"] = automation();
            if case["absent"] != json!(true) {
                value["automation"]["partyHeal"] = case["value"].clone();
            }
            assert_eq!(
                valid(value.clone()),
                case["valid"] == json!(true),
                "{}",
                case["name"]
            );
            if case["valid"] == json!(true) {
                let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            }
        }
    }

    #[test]
    fn recovery_item_shared_schema_matches_settings_and_current_form() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/data/recovery-item-cases.json"))
                .unwrap();
        for case in cases {
            let mut value = settings();
            value["automation"] = automation();
            let field = if case["resource"] == json!("hp") {
                "hpPotions"
            } else {
                "spPotions"
            };
            if case["absent"] != json!(true) {
                value["automation"][field] = case["policy"].clone();
            }
            let expected = case["valid"] == json!(true);
            assert_eq!(valid(value.clone()), expected, "{}", case["name"]);
            let document_value = json!({
                "version": 1, "revision": 1, "selectedProfileId": null, "settings": value
            });
            let document = serde_json::from_value::<crate::settings::current_form::FormDocument>(
                document_value.clone(),
            );
            assert_eq!(
                document
                    .as_ref()
                    .is_ok_and(|document| document.validate().is_ok()),
                expected,
                "{}",
                case["name"]
            );
            if expected {
                let directory = tempfile::tempdir().unwrap();
                let path = directory.path().canonicalize().unwrap();
                crate::settings::current_form::save(path.clone(), &document.unwrap()).unwrap();
                let restored = crate::settings::current_form::load(path).unwrap().unwrap();
                assert_eq!(serde_json::to_value(restored).unwrap(), document_value);
            }
        }
    }

    #[test]
    fn hp_potion_shared_schema_matches_settings_and_current_form() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/data/hp-potion-cases.json")).unwrap();
        for case in cases {
            let mut value = settings();
            value["automation"] = automation();
            if case["absent"] != json!(true) {
                value["automation"]["hpPotions"] = case["policy"].clone();
            }
            let expected = case["valid"] == json!(true);
            assert_eq!(valid(value.clone()), expected, "{}", case["name"]);
            if expected {
                let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
                assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            }

            value["map"] = json!("");
            value["targets"] = json!([]);
            let document_value = json!({
                "version": 1, "revision": 1, "selectedProfileId": "potion-profile", "settings": value
            });
            let document = serde_json::from_value::<crate::settings::current_form::FormDocument>(
                document_value.clone(),
            );
            assert_eq!(
                document
                    .as_ref()
                    .is_ok_and(|document| document.validate().is_ok()),
                expected,
                "current form: {}",
                case["name"]
            );
            if expected {
                assert_eq!(
                    serde_json::to_value(document.unwrap()).unwrap(),
                    document_value
                );
            }
        }
    }

    #[test]
    fn hp_potion_policy_requires_every_field_and_string_modes() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["hpPotions"] = json!({
            "mode": "selected", "itemIds": [501, 504], "belowPercent": 1,
            "minStock": 9999, "cooldownSeconds": 3600
        });
        assert!(valid(value.clone()));
        for field in [
            "mode",
            "itemIds",
            "belowPercent",
            "minStock",
            "cooldownSeconds",
        ] {
            let mut missing = value.clone();
            missing["automation"]["hpPotions"]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(!valid(missing), "missing {field}");
            let mut null = value.clone();
            null["automation"]["hpPotions"][field] = Value::Null;
            assert!(!valid(null), "null {field}");
        }
        for mode in [json!({"off": null}), json!({"any": null}), json!(false)] {
            let mut invalid = value.clone();
            invalid["automation"]["hpPotions"]["mode"] = mode;
            assert!(!valid(invalid));
        }
    }

    #[test]
    fn hp_potion_policy_persists_selected_order_and_legacy_absence() {
        for policy in [
            None,
            Some(json!({
                "mode": "selected", "itemIds": [504, 501], "belowPercent": 70,
                "minStock": 3, "cooldownSeconds": 2
            })),
            Some(json!({
                "mode": "any", "itemIds": [], "belowPercent": 70,
                "minStock": 3, "cooldownSeconds": 2
            })),
        ] {
            let mut value = settings();
            value["automation"] = automation();
            if let Some(policy) = policy {
                value["automation"]["hpPotions"] = policy;
            }
            let document_value = json!({
                "version": 1, "revision": 1, "selectedProfileId": null, "settings": value
            });
            let document: crate::settings::current_form::FormDocument =
                serde_json::from_value(document_value.clone()).unwrap();
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().canonicalize().unwrap();
            crate::settings::current_form::save(path.clone(), &document).unwrap();
            let restored = crate::settings::current_form::load(path).unwrap().unwrap();
            assert_eq!(serde_json::to_value(restored).unwrap(), document_value);
        }
    }

    #[test]
    fn attack_strategy_schema_round_trip_and_bounds() {
        let mut value = settings();
        value["automation"] = automation();
        let rule = json!({"id":"opening-bolt","speciesIds":[4000,4001],"skillId":11,"level":10,"behavior":"opener","maxAttempts":3,"maxUses":2,"cooldownSeconds":1});
        value["automation"]["attackStrategies"] = json!([rule.clone(),{ "id":"repeat-bolt", "speciesIds":[4000], "skillId":11,"level":1,"behavior":"repeat","maxAttempts":3,"maxUses":3,"cooldownSeconds":2}]);
        assert!(valid(value.clone()));
        let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
        for (field, bad) in [
            ("skillId", json!(19)),
            ("level", json!(0)),
            ("maxAttempts", json!(0)),
            ("maxUses", json!(4)),
            ("cooldownSeconds", json!(3601)),
            ("speciesIds", json!([])),
            ("speciesIds", json!([4000, 4000])),
            ("id", json!("bad id")),
            ("behavior", json!("combo")),
            ("behavior", json!({"opener":null})),
            ("behavior", json!({"repeat":null})),
            ("conditions", json!(null)),
            ("rawPacket", json!([1])),
        ] {
            let mut bad_value = value.clone();
            bad_value["automation"]["attackStrategies"][0][field] = bad;
            assert!(!valid(bad_value), "{field}");
        }
        let mut duplicate = value.clone();
        duplicate["automation"]["attackStrategies"][1]["id"] = json!("opening-bolt");
        assert!(!valid(duplicate));
        let mut null = value.clone();
        null["automation"]["attackStrategies"] = Value::Null;
        assert!(!valid(null));
        let mut candidate = value.clone();
        candidate["automation"]["attackStrategies"][0]["conditions"] = json!([{ "field":"actorStatus","actor":{"scope":"candidate"},"statusId":1,"operator":"eq","value":false}]);
        assert!(!valid(candidate));
    }

    fn disposition() -> Value {
        json!({"maxSpend":100,"rules":[{"itemId":501,"keep":2,"minimum":3,"desired":5,"maximum":6,"store":true,"sell":false,"cart":false,"restock":"storage","allowUnique":false}]})
    }

    #[test]
    fn disposition_round_trip_preserves_permissions_and_legacy_absence() {
        let mut value = settings();
        value["automation"] = automation();
        let legacy: Settings = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(legacy).unwrap(), value);
        value["automation"]["disposition"] = disposition();
        value["automation"]["escape"] = json!({"enabled":true,"hpBelowPercent":20,"mode":"save","method":"item","minStock":2,"cooldownSeconds":60});
        let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    #[test]
    fn disposition_rejects_conflicts_coercion_missing_and_unknown_fields() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["disposition"] = disposition();
        for (field, invalid) in [
            ("itemId", json!(0)),
            ("itemId", json!(2147483648_u32)),
            ("keep", json!(4)),
            ("minimum", json!(6)),
            ("desired", json!(7)),
            ("maximum", json!(32768)),
            ("maximum", json!(0.5)),
            ("sell", json!(1)),
            ("allowUnique", json!("true")),
            ("restock", json!("any")),
            ("unexpected", json!(true)),
        ] {
            let mut changed = value.clone();
            changed["automation"]["disposition"]["rules"][0][field] = invalid;
            assert!(!valid(changed), "accepted invalid {field}");
        }
        for invalid in [
            json!(null),
            json!({"rules":[]}),
            json!({"maxSpend":2000000001_u32,"rules":[]}),
        ] {
            let mut changed = value.clone();
            changed["automation"]["disposition"] = invalid;
            assert!(!valid(changed));
        }
        let duplicate = value["automation"]["disposition"]["rules"][0].clone();
        value["automation"]["disposition"]["rules"] = json!([duplicate.clone(), duplicate]);
        assert!(!valid(value));
    }

    #[test]
    fn disposition_accepts_protocol_quantity_and_spending_ceilings() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["disposition"] = disposition();
        value["automation"]["disposition"]["maxSpend"] = json!(2000000000);
        value["automation"]["disposition"]["rules"][0]["desired"] = json!(32767);
        value["automation"]["disposition"]["rules"][0]["maximum"] = json!(32767);
        assert!(valid(value));
    }

    #[test]
    fn disposition_restock_accepts_only_canonical_strings() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["disposition"] = disposition();
        for mode in ["off", "storage", "cart", "buy"] {
            value["automation"]["disposition"]["rules"][0]["restock"] = json!(mode);
            assert!(valid(value.clone()));
            let parsed: Settings = serde_json::from_str(&value.to_string()).unwrap();
            assert_eq!(serde_json::to_value(parsed).unwrap(), value);
            value["automation"]["disposition"]["rules"][0]["restock"] = json!({mode:null});
            assert!(!valid(value.clone()));
            assert!(serde_json::from_str::<Settings>(&value.to_string()).is_err());
        }
        for invalid in [
            json!(null),
            json!("unknown"),
            json!(1),
            json!(false),
            json!([]),
        ] {
            value["automation"]["disposition"]["rules"][0]["restock"] = invalid;
            assert!(!valid(value.clone()));
        }
    }

    #[test]
    fn defaults_legacy_escape_to_disabled_and_validates_policy_bounds() {
        let mut value = settings();
        value["automation"] = automation();
        let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
        assert!(!parsed.automation.unwrap().escape.enabled);
        for mode in ["random", "save"] {
            for method in ["item", "skill"] {
                value["automation"]["escape"] = json!({"enabled":true,"hpBelowPercent":95,"mode":mode,"method":method,"minStock":9999,"cooldownSeconds":3600});
                assert!(valid(value.clone()));
            }
        }
        for (field, invalid) in [
            ("enabled", json!(1)),
            ("hpBelowPercent", json!(0)),
            ("hpBelowPercent", json!(96)),
            ("hpBelowPercent", json!(1.5)),
            ("mode", json!("memo")),
            ("method", json!("debug")),
            ("minStock", json!(-1)),
            ("minStock", json!(10000)),
            ("cooldownSeconds", json!(0)),
            ("cooldownSeconds", json!(3601)),
            ("opcode", json!(21)),
        ] {
            let mut candidate = value.clone();
            candidate["automation"]["escape"][field] = invalid;
            assert!(!valid(candidate), "accepted {field}");
        }
        value["automation"]["escape"] = Value::Null;
        assert!(!valid(value));
    }

    #[test]
    fn threat_escape_shared_policy_and_guard_boundaries() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/data/threat-escape-cases.json"))
                .unwrap();
        for case in cases {
            let accepted = if case["kind"] == "guard" {
                serde_json::from_value::<EscapeResumeGuard>(case["value"].clone()).is_ok_and(
                    |guard| {
                        EscapeResume::try_from(&guard).is_ok_and(|admitted| {
                            assert_eq!(
                                serde_json::to_value(&admitted).unwrap(),
                                serde_json::to_value(&guard).unwrap()
                            );
                            true
                        })
                    },
                )
            } else {
                let mut value = settings();
                value["automation"] = automation();
                value["automation"]["escape"] = case["value"].clone();
                value["automation"]["items"] = json!([{
                    "itemId": 501, "resource": "hp", "belowPercent": 80, "minStock": 0, "cooldownSeconds": 1,
                    "conditions": [{"field": "actorSpPercent", "actor": {"scope": "self"}, "operator": "gte", "value": 25.5}]
                }]);
                let playable = valid(value.clone());
                value["map"] = json!("");
                value["targets"] = json!([]);
                let form = serde_json::from_value::<crate::settings::current_form::FormDocument>(
                    json!({
                        "version": 1, "revision": 1, "selectedProfileId": "threat-profile", "settings": value
                    }),
                );
                let form_accepted = form
                    .as_ref()
                    .is_ok_and(|document| document.validate().is_ok());
                assert_eq!(form_accepted, playable, "current form: {}", case["name"]);
                if form_accepted {
                    let document = form.unwrap();
                    assert!(document.settings.validate().is_err());
                    let encoded = serde_json::to_value(&document).unwrap();
                    let decoded: crate::settings::current_form::FormDocument =
                        serde_json::from_value(encoded.clone()).unwrap();
                    assert!(decoded.validate().is_ok());
                    assert_eq!(serde_json::to_value(decoded).unwrap(), encoded);
                }
                playable
            };
            assert_eq!(
                accepted,
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let legacy: Escape = serde_json::from_value(json!({"enabled":true,"hpBelowPercent":20,"mode":"random","method":"item","minStock":0,"cooldownSeconds":60})).unwrap();
        assert!(legacy.hp_enabled);
        assert!(!legacy.threat_enabled);
        assert_eq!(legacy.threat_count, 3);
        assert_eq!(legacy.threat_window_seconds, 10);
    }

    #[test]
    fn validates_ephemeral_escape_resume_state_separately_from_profiles() {
        for seconds in [0, 3600] {
            let guard: EscapeResumeGuard =
                serde_json::from_value(json!({"cooldownSeconds":seconds,"latched":true})).unwrap();
            assert!(guard.validate().is_ok());
        }
        let guard: EscapeResumeGuard =
            serde_json::from_value(json!({"cooldownSeconds":3601,"latched":false})).unwrap();
        assert!(guard.validate().is_err());
        for value in [
            json!({"cooldownSeconds":-1,"latched":true}),
            json!({"cooldownSeconds":1,"latched":1}),
            json!({"cooldownSeconds":1,"latched":true,"opcode":21}),
        ] {
            assert!(serde_json::from_value::<EscapeResumeGuard>(value).is_err());
        }
    }

    #[test]
    fn migrates_old_loadouts_and_preserves_opt_in_preferences() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]
            .as_object_mut()
            .unwrap()
            .remove("loadout");
        let parsed: Settings = serde_json::from_value(value).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["automation"]["loadout"],
            automation()["loadout"]
        );
        let mut current = settings();
        current["automation"] = automation();
        current["automation"]["loadout"]["enabled"] = json!(true);
        current["automation"]["loadout"]["ammoPreferences"] =
            json!([{ "itemId":1751 },{ "itemId":1750 }]);
        let parsed: Settings = serde_json::from_value(current.clone()).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(serde_json::to_value(parsed).unwrap(), current);
    }
    #[test]
    fn rejects_invalid_loadout_bounds_and_unknown_owned_state() {
        for (field, bad) in [
            ("minAmmoStock", json!(10000)),
            ("cooldownSeconds", json!(0)),
            ("restore", json!("always")),
            ("restore", json!({"conditionEnd":null})),
            ("restore", json!({"never":null})),
            ("enabled", json!("yes")),
            ("prior", json!({"guid":"excluded"})),
            (
                "ammoPreferences",
                json!([{ "itemId":1750 },{ "itemId":1750 }]),
            ),
            (
                "ammoPreferences",
                json!([{ "itemId":1750,"guid":"excluded" }]),
            ),
        ] {
            let mut value = settings();
            value["automation"] = automation();
            value["automation"]["loadout"][field] = bad;
            assert!(!valid(value));
        }
    }

    #[test]
    fn accepts_zero_remaining_death_allowance_and_rejects_out_of_bounds() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["respawn"] = json!({"enabled": true, "maxDeaths": 0});
        assert!(valid(value.clone()));
        for limit in [json!(-1), json!(101), json!(0.5)] {
            value["automation"]["respawn"]["maxDeaths"] = limit;
            assert!(!valid(value.clone()));
        }
    }

    #[test]
    fn preserves_legacy_settings_and_known_maps() {
        let original = settings();
        let parsed: Settings = serde_json::from_value(original.clone()).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(serde_json::to_value(parsed).unwrap(), original);
        for map in [
            "prt_fild08",
            "pay_fild02",
            "pay_fild03",
            "gef_dun03",
            "yuno",
        ] {
            let mut value = settings();
            value["map"] = map.into();
            assert!(valid(value));
        }
        for map in [
            "unsupported_map",
            "payon_p",
            "2009rwc_03",
            "pvp_n_1-5",
            "../another-map",
            "",
        ] {
            let mut value = settings();
            value["map"] = map.into();
            assert!(!valid(value));
        }
    }

    #[test]
    fn round_trips_representative_automation_without_changing_fields() {
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["combat"]["rules"] =
            json!([{"classId":4000,"action":"attack","priority":100}]);
        value["automation"]["loot"]["rules"] =
            json!([{"itemId":501,"action":"ignore","priority":-100}]);
        value["automation"]["items"] = json!([{"itemId":501,"resource":"hp","belowPercent":70,"minStock":5,"cooldownSeconds":3}]);
        value["automation"]["skills"] = json!([{"skillId":28,"level":10,"target":"enemy","hpBelowPercent":100,"spAbovePercent":10,"cooldownSeconds":1},{"skillId":29,"level":1,"target":"self","hpBelowPercent":70,"spAbovePercent":0,"cooldownSeconds":2}]);
        value["automation"]["equipment"] =
            json!([{"itemId":1201,"hpBelowPercent":100,"monsterClassId":0}]);
        value["automation"]["allocation"] =
            json!({"stats":[{"stat":0,"target":99}],"skills":[{"skillId":28,"target":10}]});
        value["automation"]["travel"]["waypoints"] = json!([{"map":"prt_fild08","x":511,"y":0}]);
        let parsed: Settings = serde_json::from_value(value.clone()).unwrap();
        assert!(parsed.validate().is_ok());
        assert_eq!(serde_json::to_value(parsed).unwrap(), value);
    }

    #[test]
    fn rejects_unknown_fields_at_every_nested_boundary() {
        let mut value = settings();
        value["automation"] = automation();
        for path in [
            "",
            "/automation",
            "/automation/combat",
            "/automation/loot",
            "/automation/recovery",
            "/automation/allocation",
            "/automation/follow",
            "/automation/travel",
            "/automation/limits",
            "/automation/respawn",
            "/automation/schedule",
        ] {
            let mut invalid = value.clone();
            invalid
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), true.into());
            assert!(!valid(invalid), "accepted unknown field at {path}");
        }
        for (path, entry) in [
            (
                "/automation/combat/rules",
                json!({"classId":4000,"action":"attack","priority":0}),
            ),
            (
                "/automation/loot/rules",
                json!({"itemId":501,"action":"pickup","priority":0}),
            ),
            (
                "/automation/items",
                json!({"itemId":501,"resource":"hp","belowPercent":70,"minStock":0,"cooldownSeconds":1}),
            ),
            (
                "/automation/skills",
                json!({"skillId":1,"level":1,"target":"enemy","hpBelowPercent":100,"spAbovePercent":0,"cooldownSeconds":1}),
            ),
            (
                "/automation/equipment",
                json!({"itemId":1201,"hpBelowPercent":100,"monsterClassId":0}),
            ),
            (
                "/automation/allocation/stats",
                json!({"stat":0,"target":10}),
            ),
            (
                "/automation/allocation/skills",
                json!({"skillId":1,"target":10}),
            ),
            (
                "/automation/travel/waypoints",
                json!({"map":"prt_fild08","x":1,"y":1}),
            ),
        ] {
            let mut invalid = value.clone();
            let mut entry = entry;
            entry
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), true.into());
            *invalid.pointer_mut(path).unwrap() = json!([entry]);
            assert!(!valid(invalid), "accepted unknown field at {path}");
        }
    }

    #[test]
    fn enforces_empty_target_modes_without_a_recovery_cutoff_floor() {
        let mut value = settings();
        value["targets"] = json!([]);
        assert!(!valid(value.clone()));
        value["automation"] = automation();
        for mode in ["selected", "both"] {
            value["automation"]["combat"]["mode"] = mode.into();
            assert!(!valid(value.clone()));
        }
        for mode in ["off", "retaliate"] {
            value["automation"]["combat"]["mode"] = mode.into();
            assert!(valid(value.clone()));
        }
        value["automation"]["combat"]["mode"] = "selected".into();
        value["automation"]["combat"]["rules"] =
            json!([{"classId":4000,"action":"attack","priority":0}]);
        assert!(valid(value.clone()));
        value["automation"]["recovery"]["enabled"] = true.into();
        value["automation"]["recovery"]["hpStart"] = 45.into();
        assert!(valid(value));
    }

    #[test]
    fn accepts_independent_recovery_thresholds_and_drops_legacy_cutoff() {
        for hp_start in [1, 2, 45, 95] {
            for cutoff in [
                json!(45),
                json!(95),
                Value::Null,
                json!("obsolete"),
                json!({"ignored":true}),
            ] {
                let mut value = settings();
                value["minHpPercent"] = cutoff;
                value["automation"] = automation();
                value["automation"]["recovery"]["enabled"] = true.into();
                value["automation"]["recovery"]["hpStart"] = hp_start.into();
                value["automation"]["recovery"]["hpEnd"] = 100.into();
                let settings: Settings = serde_json::from_value(value).unwrap();
                assert!(settings.validate().is_ok());
                assert!(settings.validate_form().is_ok());
                let encoded = serde_json::to_value(&settings).unwrap();
                assert!(encoded.get("minHpPercent").is_none());
                assert_eq!(encoded["automation"]["recovery"]["hpStart"], hp_start);
                assert!(
                    serde_json::to_value(RunSettings::try_from(&settings).unwrap())
                        .unwrap()
                        .get("minHpPercent")
                        .is_none()
                );
            }
        }
        let mut current = settings();
        current.as_object_mut().unwrap().remove("minHpPercent");
        let settings: Settings = serde_json::from_value(current).unwrap();
        assert!(settings.validate().is_ok());
    }

    #[test]
    fn rejects_bounds_duplicates_and_invalid_types() {
        let mut value = settings();
        value["automation"] = automation();
        for (path, invalid) in [
            ("/radius", json!(21)),
            ("/route_randomWalk", json!(1)),
            ("/route_step", json!(0)),
            ("/route_randomWalk_maxRouteTime", json!(601)),
            ("/attackRouteMaxPathDistance", json!(201)),
            ("/attackMaxRouteTime", json!(61)),
            ("/loot", json!(1)),
            ("/targets", json!([4000, 4000])),
            ("/targets", json!([0])),
            ("/targets", json!([2_147_483_648_u32])),
            ("/automation/combat/levelDifference", json!(101)),
            ("/automation/combat/mode", json!("invalid")),
            ("/automation/recovery/hpEnd", json!(60)),
            ("/automation/recovery/spEnd", json!(10)),
            ("/automation/recovery/timeoutSeconds", json!(3601)),
            ("/automation/follow/distance", json!(0)),
            ("/automation/follow/lostSeconds", json!(121)),
            ("/automation/follow/name", json!("x\n")),
            ("/automation/travel/destinationMap", json!("../map")),
            (
                "/automation/travel/waypoints",
                json!([{"map":"prt_fild08","x":512,"y":0}]),
            ),
            ("/automation/limits/minutes", json!(1441)),
            ("/automation/limits/kills", json!(1_000_001)),
            ("/automation/limits/weightPercent", json!(101)),
            ("/automation/respawn/maxDeaths", json!(-1)),
            ("/automation/schedule/startHour", json!(24)),
            (
                "/automation/items",
                json!([{"itemId":501,"resource":"hp","belowPercent":70,"minStock":10_000,"cooldownSeconds":1}]),
            ),
            (
                "/automation/skills",
                json!([{"skillId":256,"level":1,"target":"enemy","hpBelowPercent":100,"spAbovePercent":0,"cooldownSeconds":1}]),
            ),
            (
                "/automation/allocation/stats",
                json!([{"stat":6,"target":10}]),
            ),
        ] {
            let mut invalid_value = value.clone();
            *invalid_value.pointer_mut(path).unwrap() = invalid;
            assert!(!valid(invalid_value), "accepted invalid value at {path}");
        }
        value["automation"]["follow"]["name"] = "😀".repeat(25).into();
        assert!(!valid(value));
    }
    #[test]
    fn optional_actor_conditions_preserve_legacy_and_reject_invalid_imports() {
        let plain = settings();
        let parsed: Settings = serde_json::from_value(plain.clone()).unwrap();
        assert_eq!(serde_json::to_value(parsed).unwrap(), plain);
        let predicate = json!({"field":"actorStatus","actor":{"scope":"self"},"statusId":1,"operator":"eq","value":false});
        let item = json!({"itemId":501,"resource":"hp","belowPercent":80,"minStock":0,"cooldownSeconds":1,"conditions":[predicate.clone()]});
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["items"] = json!([item]);
        assert!(valid(value.clone()));
        for invalid in [
            json!(null),
            json!(vec![predicate.clone(); 17]),
            json!([{"field":"actorStatus","actor":{"scope":"candidate"},"statusId":1,"operator":"eq","value":false}]),
            json!([{"field":"actorStatus","actor":{"scope":"self"},"statusId":1,"operator":"eq","value":false,"unknown":true}]),
        ] {
            let mut malformed = value.clone();
            malformed["automation"]["items"][0]["conditions"] = invalid;
            assert!(!valid(malformed));
        }
        value["automation"]["combat"]["rules"] = json!([{"classId":4000,"action":"attack","priority":0,"conditions":[{"field":"actorStatus","actor":{"scope":"candidate"},"statusId":1,"operator":"eq","value":false}]}]);
        assert!(valid(value));
    }
    #[test]
    fn supply_settings_and_reload_guards_match_shared_ts_boundaries() {
        let cases: Value =
            serde_json::from_str(include_str!("../../../src/data/supply-boundary-cases.json"))
                .unwrap();
        for case in cases.as_array().unwrap() {
            let actual = if case["kind"] == "settings" {
                serde_json::from_value::<SupplySettings>(case["value"].clone())
                    .is_ok_and(|v| v.valid())
            } else {
                serde_json::from_value::<SupplyResumeGuard>(case["value"].clone()).is_ok_and(
                    |guard| {
                        SupplyResume::try_from(&guard).is_ok_and(|admitted| {
                            assert_eq!(
                                serde_json::to_value(&admitted).unwrap(),
                                serde_json::to_value(&guard).unwrap()
                            );
                            true
                        })
                    },
                )
            };
            assert_eq!(actual, case["valid"].as_bool().unwrap(), "{}", case["name"]);
        }
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["supply"] = cases[0]["value"].clone();
        assert!(valid(value.clone()));
        let legacy: SupplySettings = serde_json::from_value(cases[0]["value"].clone()).unwrap();
        let normalized = serde_json::to_value(legacy).unwrap();
        assert_eq!(normalized["sellAllPermitted"], false);
        assert_eq!(normalized["merchantMode"], "manual");
        assert_eq!(normalized["transport"], "travel");
        assert_eq!(normalized["saveMap"], "");
        assert_eq!(normalized["returnMinStock"], 1);
        let enabled: SupplySettings = serde_json::from_value(
            cases
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["name"] == "sell all permitted enabled")
                .unwrap()["value"]
                .clone(),
        )
        .unwrap();
        let enabled = serde_json::to_value(enabled).unwrap();
        assert_eq!(enabled["sellAllPermitted"], true);
        assert_eq!(enabled["maxTrips"], 0);
        let legacy_guard: SupplyResumeGuard = serde_json::from_value(
            cases
                .as_array()
                .unwrap()
                .iter()
                .find(|case| case["kind"] == "guard" && case["valid"] == true)
                .unwrap()["value"]
                .clone(),
        )
        .unwrap();
        assert_eq!(
            serde_json::to_value(legacy_guard).unwrap()["tripSequence"],
            0
        );
        value["automation"]["supply"] = Value::Null;
        assert!(!valid(value.clone()));
        value["automation"]
            .as_object_mut()
            .unwrap()
            .remove("supply");
        assert!(valid(value));
    }
    #[test]
    fn map_policy_shared_boundary_cases() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../../src/data/map-policy-cases.json")).unwrap();
        for case in cases {
            assert_eq!(
                super::validate_map_policy(&case["policy"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        let mut value = settings();
        value["automation"] = automation();
        value["automation"]["mapPolicy"] = json!({"mode":"legacy","allow":[],"deny":[],"penalties":[],"lockArea":{"map":"prontera","minX":0,"minY":0,"maxX":10,"maxY":10}});
        assert!(serde_json::from_value::<Settings>(value)
            .unwrap()
            .validate()
            .is_err());
    }
}

#[cfg(test)]
mod death_recovery_guard_tests {
    use super::{DeathRecoveryGuard, DeathResume};
    #[test]
    fn matches_strict_death_recovery_guard_corpus() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../../src/data/death-recovery-guards.json"))
                .unwrap();
        for case in cases {
            let result = serde_json::from_str::<DeathRecoveryGuard>(case["json"].as_str().unwrap())
                .and_then(|guard| {
                    DeathResume::try_from(&guard)
                        .map(|admitted| {
                            assert_eq!(
                                serde_json::to_value(&admitted).unwrap(),
                                serde_json::to_value(&guard).unwrap()
                            );
                        })
                        .map_err(serde::de::Error::custom)
                });
            assert_eq!(
                result.is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}
