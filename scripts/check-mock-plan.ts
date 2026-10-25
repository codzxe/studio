// Sanity check: the new mockEditPlan compiles through the REAL plan compiler.
import { EDIT_PLAN_SCHEMA } from "@studio/contracts";
import { compilePlan, defaultCompileDeps } from "../services/gateway/src/plan-compiler.js";
import { mockEditPlan } from "../services/gateway/src/runner.js";

const plan = mockEditPlan();
const parsedAgain = EDIT_PLAN_SCHEMA.safeParse(plan);
console.log("schema-valid:", parsedAgain.success);
const compiled = compilePlan(plan, defaultCompileDeps());
console.log("ok:", compiled.ok);
if (compiled.ok) {
  console.log("commands:", compiled.batch.steps.map((s) => s.command));
  console.log("label:", compiled.batch.label);
  console.log("risk:", compiled.risk, "credits:", compiled.estimatedCredits);
  console.log("resolutionRequests:", compiled.resolutionRequests);
  console.log("placeholders:", compiled.placeholders);
  console.log("warnings:", compiled.warnings.map((w) => `${w.code}: ${w.message}`));
  console.log("atomic:", compiled.batch.atomic, "steps:", compiled.batch.steps.length);
} else {
  console.log("issues:", compiled.issues);
}
