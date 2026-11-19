import assert from "node:assert/strict";
import test from "node:test";

import {
  DURABLE_PROJECT_TEMPLATES,
  durableProjectTeamPlan,
  durableProjectTemplate,
} from "../src/project-templates.js";

test("project templates have stable unique IDs and executable team plans", () => {
  assert.deepEqual(
    DURABLE_PROJECT_TEMPLATES.map((template) => template.id),
    ["blank", "web", "python", "research", "cross-platform"],
  );
  assert.equal(new Set(DURABLE_PROJECT_TEMPLATES.map((template) => template.id)).size, DURABLE_PROJECT_TEMPLATES.length);

  for (const template of DURABLE_PROJECT_TEMPLATES) {
    const plan = durableProjectTeamPlan(template);
    assert.equal(plan.filter((member) => member.role === "coordinator").length, 1);
    assert.equal(new Set(plan.map((member) => member.role)).size, plan.length);
    assert.ok(template.maxConcurrentTasks > 0);
    assert.ok(template.maxConcurrentTasks <= template.maxActiveTasks);
  }
});

test("blank keeps an uncluttered suggestion list but receives a coordinator when applied", () => {
  const blank = durableProjectTemplate("blank");
  assert.ok(blank);
  assert.deepEqual(blank.suggestedRoles, []);
  assert.deepEqual(durableProjectTeamPlan(blank), [{ role: "coordinator", permissionProfile: "READ_ONLY" }]);
  assert.equal(durableProjectTemplate("missing"), undefined);
});
