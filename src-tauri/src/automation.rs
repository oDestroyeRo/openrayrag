use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::hash::Hash;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    map: String,
    targets: Vec<u32>,
    radius: u8,
    min_hp_percent: u8,
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

impl Settings {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(1..=20).contains(&self.radius)
            || !(20..=95).contains(&self.min_hp_percent)
            || !crate::supported_map(&self.map)
            || !map_code(&self.map, false)
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
            return if self.targets.is_empty() {
                Err("Choose selected monsters.".into())
            } else {
                Ok(())
            };
        };
        automation.validate()?;
        if self.targets.is_empty()
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
        if automation.recovery.enabled && automation.recovery.hp_start <= self.min_hp_percent {
            return Err("Recovery HP start must be above the emergency HP stop limit.".into());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AutomationSettings {
    combat: Combat,
    loot: Loot,
    recovery: Recovery,
    #[serde(default, skip_serializing_if = "Escape::is_default")]
    escape: Escape,
    items: Vec<ItemRule>,
    skills: Vec<SkillRule>,
    equipment: Vec<EquipmentRule>,
    allocation: Allocation,
    follow: Follow,
    travel: Travel,
    limits: Limits,
    respawn: Respawn,
    schedule: Schedule,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Escape {
    enabled: bool,
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

impl Default for Escape {
    fn default() -> Self {
        Self {
            enabled: false,
            hp_below_percent: 20,
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
}
impl EscapeResumeGuard {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.cooldown_seconds <= 3600 {
            Ok(())
        } else {
            Err("Invalid escape resume guard.".into())
        }
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Combat {
    mode: CombatMode,
    level_difference: i16,
    rules: Vec<MonsterRule>,
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ItemRule {
    item_id: u32,
    resource: Resource,
    below_percent: u8,
    min_stock: u16,
    cooldown_seconds: u16,
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
struct EquipmentRule {
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

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Follow {
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
        let valid = (-100..=100).contains(&self.combat.level_difference)
            && self.combat.rules.len() <= 64
            && unique_by(&self.combat.rules, |r| r.class_id)
            && self
                .combat
                .rules
                .iter()
                .all(|r| positive_id(r.class_id) && (-100..=100).contains(&r.priority))
            && self.loot.rules.len() <= 128
            && unique_by(&self.loot.rules, |r| r.item_id)
            && self
                .loot
                .rules
                .iter()
                .all(|r| positive_id(r.item_id) && (-100..=100).contains(&r.priority))
            && (1..=95).contains(&self.recovery.hp_start)
            && (2..=100).contains(&self.recovery.hp_end)
            && self.recovery.sp_start <= 95
            && (1..=100).contains(&self.recovery.sp_end)
            && (1..=3600).contains(&self.recovery.timeout_seconds)
            && self.recovery.hp_start < self.recovery.hp_end
            && self.recovery.sp_start < self.recovery.sp_end
            && (1..=95).contains(&self.escape.hp_below_percent)
            && self.escape.min_stock <= 9999
            && (1..=3600).contains(&self.escape.cooldown_seconds)
            && self.items.len() <= 32
            && unique_by(&self.items, |r| r.item_id)
            && self.items.iter().all(|r| {
                positive_id(r.item_id)
                    && (1..=100).contains(&r.below_percent)
                    && r.min_stock <= 9999
                    && (1..=3600).contains(&r.cooldown_seconds)
            })
            && self.skills.len() <= 32
            && unique_by(&self.skills, |r| r.skill_id)
            && self.skills.iter().all(|r| {
                (1..=255).contains(&r.skill_id)
                    && (1..=10).contains(&r.level)
                    && (1..=100).contains(&r.hp_below_percent)
                    && r.sp_above_percent <= 100
                    && (1..=3600).contains(&r.cooldown_seconds)
            })
            && self.equipment.len() <= 32
            && unique_by(&self.equipment, |r| r.item_id)
            && self.equipment.iter().all(|r| {
                positive_id(r.item_id)
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
        if valid {
            Ok(())
        } else {
            Err("Invalid automation settings.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{EscapeResumeGuard, Settings};
    use serde_json::{json, Value};

    fn settings() -> Value {
        json!({
            "map": "prt_fild08", "targets": [4000], "radius": 12,
            "minHpPercent": 45, "loot": true, "route_randomWalk": 0,
            "route_step": 10, "route_avoidWalls": true,
            "route_randomWalk_maxRouteTime": 75,
            "attackRouteMaxPathDistance": 20, "attackMaxRouteTime": 4
        })
    }

    fn automation() -> Value {
        json!({
            "combat": {"mode": "selected", "levelDifference": 1, "rules": []},
            "loot": {"ownership": "own", "defaultAction": "pickup", "rules": []},
            "recovery": {"enabled": false, "hpStart": 60, "hpEnd": 85, "spStart": 10, "spEnd": 80, "timeoutSeconds": 300},
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
    fn enforces_empty_target_modes_and_recovery_emergency_limit() {
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
        assert!(!valid(value));
    }

    #[test]
    fn rejects_bounds_duplicates_and_invalid_types() {
        let mut value = settings();
        value["automation"] = automation();
        for (path, invalid) in [
            ("/radius", json!(21)),
            ("/minHpPercent", json!(19)),
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
}
