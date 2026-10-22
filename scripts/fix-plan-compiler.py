#!/usr/bin/env python3
"""Integrator fix for F-5/G-1/G-2/G-3/G-6/G-7 (M5 wave-2 closeout).

Aligns plan-compiler translate() with the LANDED @studio/contracts
write-tool args shapes (M5-A), makes zero-command steps fatal (G-3),
maps path:"name" to layer.rename (G-7), applies the model's declared risk
as a floor (G-4), and gives apply_preset a plan-context fallback (G-6, D-21).
"""
import re
import sys

PATH = "/home/z/my-project/services/gateway/src/plan-compiler.ts"
src = open(PATH, encoding="utf-8").read()

def replace_case(name: str, new_block: str, tool: str) -> None:
    global src
    pattern = re.compile(
        r'      case "' + re.escape(tool) + r'": \{.*?\n      \}\n',
        re.DOTALL,
    )
    match = pattern.search(src)
    if match is None:
        sys.exit(f"FAIL: case block not found for {tool}")
    src = src[: match.start()] + new_block + src[match.end():]

# ---------------------------------------------------------------- set_properties
set_properties = '''      case "set_properties": {
        // M5-A shape: {layers: [{name}], properties: [{path, value}]} ->
        // cross-product prop.set per layer x property; a "name" path maps to
        // layer.rename (G-7 -- rename was otherwise inexpressible).
        const layers = readLayerNames(argsObj.layers);
        const properties = argsObj.properties;
        if (layers.length === 0) {
          unusable("layers", "no usable named layers");
          compilesToNothing();
          break;
        }
        if (!Array.isArray(properties)) {
          unusable("properties", "is not an array");
          compilesToNothing();
          break;
        }
        for (const property of properties) {
          if (!isPlainObject(property)) {
            unusable("properties", "contains a non-object entry (skipped)");
            continue;
          }
          const path = readString(property, "path");
          if (path === undefined) {
            unusable("properties", "entry has no path (skipped)");
            continue;
          }
          for (const layer of layers) {
            if (path === "name") {
              const value = readString(property, "value");
              if (value === undefined) {
                unusable("properties", "a rename needs a string value (skipped)");
                continue;
              }
              add("layer.rename", { layer, name: value });
            } else {
              const params: Record<string, unknown> = { layer, path };
              if ("value" in property) params.value = property.value;
              add("prop.set", params);
            }
            addSite("layer", layer);
          }
        }
        if (steps.length === 0) compilesToNothing();
        break;
      }
'''
replace_case("set_properties", set_properties, "set_properties")

# ---------------------------------------------------------------- set_keyframes
set_keyframes = '''      case "set_keyframes": {
        // M5-A shape: {layers: [{name}], propertyPath, keys: [{timeSeconds,
        // value, interpolation?}]} -> cross-product prop.addKey per layer x key.
        const layers = readLayerNames(argsObj.layers);
        const keys = argsObj.keys;
        const propertyPath = readString(argsObj, "propertyPath");
        if (layers.length === 0) {
          unusable("layers", "no usable named layers");
          compilesToNothing();
          break;
        }
        if (!Array.isArray(keys)) {
          unusable("keys", "is not an array");
          compilesToNothing();
          break;
        }
        for (const key of keys) {
          if (!isPlainObject(key)) {
            unusable("keys", "contains a non-object entry (skipped)");
            continue;
          }
          const time = key.timeSeconds;
          const interpolation = readString(key, "interpolation");
          for (const layer of layers) {
            const params: Record<string, unknown> = { layer };
            if (propertyPath !== undefined) params.path = propertyPath;
            if (isFiniteNumber(time)) params.time = time;
            else if (time !== undefined) {
              unusable("keys", "entry timeSeconds is not a finite number");
            }
            if ("value" in key) params.value = key.value;
            if (interpolation !== undefined && interpolation !== "linear") {
              this.warn(
                "uncompilable_arg",
                `interpolation \\`${clip(interpolation, 24)}\\` is editor-side keyframe state; the key compiles with the engine default (set it via the timeline after apply)`,
                { step: planStep, tool, param: "interpolation" },
              );
            }
            add("prop.addKey", params);
            addSite("layer", layer);
          }
        }
        if (steps.length === 0) compilesToNothing();
        break;
      }
'''
replace_case("set_keyframes", set_keyframes, "set_keyframes")

# ---------------------------------------------------------------- add_effect
add_effect = '''      case "add_effect": {
        // M5-A shape: {layers: [{name}], effect: {name}, params?} ->
        // effect.apply {layers: [names], effect: name}. Effect instance
        // params are editor state (uncompilable server-side; warn + set via
        // set_properties after apply).
        const layers = readLayerNames(argsObj.layers);
        if (layers.length === 0) {
          unusable("layers", "no usable named layers");
          compilesToNothing();
          break;
        }
        const effectObj = argsObj.effect;
        const effectName = isPlainObject(effectObj) ? readString(effectObj, "name") : undefined;
        const params: Record<string, unknown> = { layers: [...layers] };
        if (effectName !== undefined) params.effect = effectName;
        else unusable("effect", "has no usable name");
        add("effect.apply", params);
        layers.forEach((layer, index) => addSite(`layers[${index}]`, layer));
        const effectParams = argsObj.params;
        if (effectParams !== undefined) {
          if (isPlainObject(effectParams)) {
            for (const key of Object.keys(effectParams).sort()) {
              this.warn(
                "uncompilable_arg",
                `effect parameter \\`${clip(key, 40)}\\` cannot be compiled server-side (the effect instance index is editor state); set it via set_properties after apply`,
                { step: planStep, tool, param: key },
              );
            }
          } else {
            unusable("params", "is not an object");
          }
        }
        break;
      }
'''
replace_case("add_effect", add_effect, "add_effect")

# ---------------------------------------------------------------- apply_preset
apply_preset = '''      case "apply_preset": {
        // M5-A shape: {preset: {name}|{builtinId}, layers? [{name}], args?}.
        // D-21 ruling: when `layers` is omitted the plan's affectedLayers
        // names are the targets (never the live editor selection -- a
        // selection-capture hazard the compiler refuses).
        const explicitLayers = readLayerNames(argsObj.layers);
        const layers =
          explicitLayers.length > 0 ? explicitLayers : [...this.planLayerNames];
        if (layers.length === 0) {
          unusable(
            "layers",
            "no target layers: neither step layers nor plan affectedLayers name any",
          );
          compilesToNothing();
          break;
        }
        const presetObj = argsObj.preset;
        let preset: string | undefined;
        if (isPlainObject(presetObj)) {
          preset = readString(presetObj, "name") ?? readString(presetObj, "builtinId");
        }
        if (preset !== undefined && PRESET_PATH_LIKE.test(preset)) {
          this.warn(
            "uncompilable_arg",
            "preset looks like a filesystem path; paths are never agent-compilable " +
              "(compiled as a builtin preset name)",
            { step: planStep, tool, param: "preset" },
          );
        }
        if (preset === undefined) {
          unusable("preset", "needs a name or builtinId");
          compilesToNothing();
          break;
        }
        const params: Record<string, unknown> = { layers: [...layers], preset };
        const presetArgs = argsObj.args;
        if (isPlainObject(presetArgs)) {
          for (const key of Object.keys(presetArgs).sort()) {
            this.warn(
              "uncompilable_arg",
              `preset arg \\`${clip(key, 40)}\\` is editor-side state; set it via set_properties after apply`,
              { step: planStep, tool, param: key },
            );
          }
        }
        add("anim.applyBuiltinPreset", params);
        layers.forEach((layer, index) => addSite(`layers[${index}]`, layer));
        break;
      }
'''
replace_case("apply_preset", apply_preset, "apply_preset")

# ------------------------------------------- create_text tail: drop the stale check
src = src.replace(
    """        if (Object.keys(params).length === 0) {
          compilesToNothing();
          break;
        }
        add("layer.newText", params);""",
    """        if (params.text === undefined) {
          compilesToNothing();
          break;
        }
        add("layer.newText", params);""",
    1,
)

# ---------------------------------------------------- create_composition: same tail rule
src = src.replace(
    """        if (Object.keys(params).length === 0) {
          compilesToNothing();
          break;
        }
        add("comp.new", params);""",
    """        if (params.name === undefined) {
          compilesToNothing();
          break;
        }
        add("comp.new", params);""",
    1,
)

# ------------------------------------------------------------- risk floor (G-4)
src = src.replace(
    """  // -- 6. risk + credits recomputed server-side (never the model's numbers).
  const risk = recomputePlanRisk(steps, compiler.toolRiskFloor());""",
    """  // -- 6. risk + credits recomputed server-side (never the model's numbers).
  // G-4: the recomputed risk is a floor-safeguarded value -- the model's
  // declared risk is never LOWERED (the card must never understate risk),
  // but the command-based floors still raise it.
  const risk = riskMax(recomputePlanRisk(steps, compiler.toolRiskFloor()), editPlan.risk);""",
    1,
)

# ------------------------------------------------- plan context before the step loop
src = src.replace(
    """  const editPlan = parsed.data;

  // -- 2. per-step: allowlist the tool, validate args, translate, validate""",
    """  const editPlan = parsed.data;
  compiler.planLayerNames = editPlan.affectedLayers
    .map((layer) => (typeof layer.name === "string" && layer.name.length > 0 ? layer.name : ""))
    .filter((name) => name !== "");

  // -- 2. per-step: allowlist the tool, validate args, translate, validate""",
    1,
)

open(PATH, "w", encoding="utf-8").write(src)
print("patched OK")
