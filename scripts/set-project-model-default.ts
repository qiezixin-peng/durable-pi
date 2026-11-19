import { resolve } from "node:path";

import { ProjectRegistry } from "../apps/dpi-sdk/src/node/projects.js";
import { ProjectTaskStore } from "../apps/dpi-sdk/src/node/tasks.js";

const databasePath = resolve(process.argv[2] ?? "");
const model = (process.argv[3] ?? "").trim();
if (!process.argv[2] || !/^[A-Za-z0-9._-]{1,160}$/.test(model)) {
  console.error("Usage: tsx scripts/set-project-model-default.ts <projects.sqlite> <model>");
  process.exit(2);
}

const projects = new ProjectRegistry(databasePath);
const tasks = new ProjectTaskStore(databasePath);
try {
  const activeProjects = projects.list();
  const busy = activeProjects.filter((project) => tasks.activeCount(project.id) > 0);
  if (busy.length)
    throw Error(`Refusing model migration while projects have unfinished tasks: ${busy.map((item) => item.id).join(", ")}`);
  let changed = 0;
  for (const project of activeProjects) {
    for (const member of project.members) {
      if (member.executor !== "codex" || member.model === model) continue;
      projects.updateMember(project.id, member.id, { model });
      changed += 1;
    }
  }
  process.stdout.write(`${JSON.stringify({ model, changed, projects: activeProjects.length })}\n`);
} finally {
  tasks.close();
  projects.close();
}
