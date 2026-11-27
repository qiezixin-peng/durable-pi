import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const databasePath = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("Usage: node scripts/reconcile-durable-project-defaults.mjs <projects.sqlite>");
  process.exit(2);
}

const providerPolicies = [
  { primaryModel: "gpt-5.6-sol", fallbackModels: ["gpt-6-astra", "gpt-6.1-sol"] },
  { primaryModel: "deepseek/deepseek-flash", fallbackModels: ["deepseek/deepseek-v4-pro"] },
];

const genericPlan = [
  { role: "coordinator", permissionProfile: "READ_ONLY" },
  { role: "coder", permissionProfile: "WORKSPACE_WRITE" },
  { role: "tester", permissionProfile: "ROLE_DEFAULT" },
  { role: "reviewer", permissionProfile: "READ_ONLY" },
];
const oldBlankDescription = "Conservative defaults and no assumed worker team.";
const newBlankDescription = "General-purpose team plan with workers activated only when the task needs them.";
const roleList = (value) => {
  try {
    const plan = JSON.parse(value ?? "[]");
    return Array.isArray(plan) ? plan.map((item) => item?.role).filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
};
const isLegacyBlankPlan = (value) => {
  const roles = roleList(value);
  return roles.length === 0 || (roles.length === 1 && roles[0] === "coordinator");
};

const database = new DatabaseSync(databasePath);
try {
  database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
  const projects = database.prepare(
    `SELECT id,template_id,template_plan_json,description,max_concurrent_tasks
     FROM projects ORDER BY created_at,id`,
  ).all();
  const activeCount = database.prepare(
    `SELECT COUNT(*) AS count FROM project_tasks
     WHERE project_id=? AND status NOT IN ('COMPLETED','FAILED','CANCELLED')`,
  );
  const updateFallbackPolicy = database.prepare(
    `UPDATE project_members SET allow_model_fallback=1,fallback_models_json=?
     WHERE project_id=? AND lifecycle_state!='ARCHIVED' AND model=?
       AND (allow_model_fallback!=1 OR fallback_models_json IS NOT ?)`,
  );
  const updateBlank = database.prepare(
    `UPDATE projects SET template_plan_json=?,description=?,max_concurrent_tasks=?,updated_at=? WHERE id=?`,
  );
  const touchProject = database.prepare("UPDATE projects SET updated_at=? WHERE id=?");
  const insertEvent = database.prepare(
    `INSERT INTO project_events(project_id,kind,from_member_id,to_member_id,detail_json,created_at)
     VALUES(?,? ,NULL,NULL,?,?)`,
  );
  let membersUpdated = 0;
  let blankPlansUpdated = 0;
  const skippedBusyProjects = [];
  for (const project of projects) {
    const active = Number(activeCount.get(project.id)?.count ?? 0);
    if (active > 0) {
      skippedBusyProjects.push({ projectId: project.id, activeTasks: active });
      continue;
    }
    const now = Date.now();
    let changedMembers = 0;
    for (const policy of providerPolicies) {
      const fallbackModelsJson = JSON.stringify(policy.fallbackModels);
      changedMembers += Number(updateFallbackPolicy.run(
        fallbackModelsJson,
        project.id,
        policy.primaryModel,
        fallbackModelsJson,
      ).changes);
    }
    const upgradeBlank = project.template_id === "blank" && isLegacyBlankPlan(project.template_plan_json);
    if (upgradeBlank) {
      updateBlank.run(
        JSON.stringify(genericPlan),
        project.description === oldBlankDescription ? newBlankDescription : project.description,
        Math.max(3, Number(project.max_concurrent_tasks ?? 0)),
        now,
        project.id,
      );
      blankPlansUpdated += 1;
    } else if (changedMembers > 0) {
      touchProject.run(now, project.id);
    }
    if (changedMembers > 0 || upgradeBlank) {
      insertEvent.run(project.id, "project.defaults.reconciled", JSON.stringify({
        membersUpdated: changedMembers,
        providerFallbackPolicies: providerPolicies,
        blankTeamPlanUpgraded: upgradeBlank,
        templatePlan: upgradeBlank ? genericPlan : undefined,
      }), now);
    }
    membersUpdated += changedMembers;
  }
  database.exec("COMMIT");
  process.stdout.write(`${JSON.stringify({
    databasePath,
    providerFallbackPolicies: providerPolicies,
    projects: projects.length,
    membersUpdated,
    blankPlansUpdated,
    skippedBusyProjects,
  })}\n`);
} catch (error) {
  try { database.exec("ROLLBACK"); } catch {}
  throw error;
} finally {
  database.close();
}
