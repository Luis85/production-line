import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { join } from "node:path";
const { chromium } = await import(
  process.env.WERK_PLAYWRIGHT_MODULE || "playwright"
);
// Use an isolated mock system with two saved tasks. Credentials stay in process memory.
if (!process.env.WERK_VISUAL_STATE)
  throw Error(
    "Set WERK_VISUAL_STATE to an isolated demo system state directory.",
  );
const factoryUrl =
  process.env.WERK_VISUAL_FACTORY_URL || "http://127.0.0.1:3100";
const lineUrl = process.env.WERK_VISUAL_LINE_URL || "http://127.0.0.1:3001";
const credential = async (path) =>
  JSON.parse(
    await readFile(
      `${process.env.WERK_VISUAL_STATE}/${path}/credentials.json`,
      "utf8",
    ),
  );
const factoryToken = (await credential("factory")).WERK_FACTORY_ADMIN_TOKEN;
const lineToken = (await credential("lines/alpha")).WERK_ADMIN_TOKEN;
const tasksResponse = await fetch(new URL("/v1/tasks?limit=50", lineUrl), {
  headers: { Authorization: `Bearer ${lineToken}` },
});
assert.equal(
  tasksResponse.status,
  200,
  "Fixture line must accept its isolated credentials",
);
const tasks = (await tasksResponse.json()).tasks;
assert(
  tasks.length >= 2,
  "Prepare two persisted mock tasks before this browser check",
);
const [taskA, taskB] = tasks;
const browser = await chromium.launch({
  executablePath: process.env.WERK_CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const errors = [],
  checks = [];
const page = await browser.newPage({
  viewport: { width: 390, height: 1000 },
  hasTouch: true,
  isMobile: true,
  reducedMotion: "reduce",
});
page.on("pageerror", (error) => errors.push(error.message));
// Optional source-build overlay; API requests still reach the isolated real runtime.
for (const [origin, directory] of [
  [factoryUrl, process.env.WERK_VISUAL_FACTORY_PUBLIC],
  [lineUrl, process.env.WERK_VISUAL_LINE_PUBLIC],
]) {
  if (!directory) continue;
  await page.route(new URL("/**", origin).href, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/" || /^\/factories\/[a-zA-Z0-9_-]+$/.test(path))
      return route.fulfill({
        contentType: "text/html",
        body: await readFile(join(directory, "index.html")),
      });
    if (/^\/assets\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(path))
      return route.fulfill({
        contentType: path.endsWith(".css") ? "text/css" : "text/javascript",
        body: await readFile(join(directory, path.slice(1))),
      });
    return route.continue();
  });
}
const check = (name, details = {}) => checks.push({ check: name, ...details });
async function activeNavigationVisible() {
  const nav = page.getByRole("navigation", { name: "Ansichten dieser Linie" });
  const active = nav.locator('[aria-current="page"]');
  await active.waitFor();
  const n = await nav.boundingBox(),
    a = await active.boundingBox();
  assert(
    n && a && a.x >= n.x - 1 && a.x + a.width <= n.x + n.width + 1,
    "Active mobile navigation stays visible",
  );
  return active.textContent();
}
async function lineNavigation(name) {
  await page
    .getByRole("navigation", { name: "Ansichten dieser Linie" })
    .getByRole("link", { name, exact: true })
    .click();
}
try {
  await page.goto(factoryUrl);
  await page.getByLabel("Zugangstoken der Fabrikverwaltung").fill(factoryToken);
  await page.getByRole("button", { name: "Verbinden", exact: true }).click();
  const factoryMap = page.locator(
    'section.spatial[aria-label="Live-Systemkarte"]',
  );
  await factoryMap.locator("canvas").waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  const position = await factoryMap.locator("canvas").boundingBox();
  assert(
    position && position.y + 150 < 1000,
    `Useful Factory map geometry in first mobile viewport: ${position?.y}`,
  );
  check("Mobile Factory map geometry in first viewport", {
    canvasTop: position.y,
  });
  const client = await page.context().newCDPSession(page);
  for (const mode of ["3D", "2D"]) {
    await factoryMap.getByRole("button", { name: mode, exact: true }).click();
    const scroll = factoryMap.locator(".spatial-scroll");
    await scroll.evaluate((node) => {
      node.scrollLeft = 0;
    });
    await scroll.scrollIntoViewIfNeeded();
    const rect = await scroll.boundingBox();
    const x = rect.x + Math.min(300, rect.width - 30),
      y = rect.y + 100;
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    for (let step = 1; step <= 8; step++) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x - step * 25, y }],
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await page.waitForFunction(
      () =>
        document.querySelector(
          'section.spatial[aria-label="Live-Systemkarte"] .spatial-scroll',
        )?.scrollLeft > 20,
    );
    await scroll.evaluate((node) => {
      node.scrollLeft = 0;
    });
    await scroll.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(
      () =>
        document.querySelector(
          'section.spatial[aria-label="Live-Systemkarte"] .spatial-scroll',
        )?.scrollLeft > 0,
    );
    check(`${mode} map supports touch and keyboard pan`);
  }
  const navigationDisclosure = page.locator("details.factory-navigation");
  if ((await navigationDisclosure.getAttribute("open")) === null)
    await navigationDisclosure.locator(":scope > summary").click();
  await page.locator("#scope-picker").click();
  const factoryOptions = page.getByRole("option");
  assert(
    (await factoryOptions.count()) > 1,
    "The fixture has a selectable Factory",
  );
  await factoryOptions.last().click();
  await page.locator("#scope-picker").click();
  await page
    .getByRole("option", { name: "Alle Fabriken", exact: true })
    .click();
  await page.waitForURL(factoryUrl + "/");
  await page.locator("#dashboard-scope").click();
  await page.getByRole("option").last().click();
  await page.waitForFunction(() => location.hash.startsWith("#line="));
  await page.locator("#dashboard-scope").click();
  await page
    .getByRole("option", { name: "Factory · alle Linien", exact: true })
    .click();
  await page.waitForURL(factoryUrl + "/");
  check("Factory selectors expose and restore all-factory and all-line scopes");
  await page.goto(lineUrl);
  await page.getByLabel("Zugangstoken", { exact: true }).fill(lineToken);
  await page.getByRole("button", { name: "Verbinden", exact: true }).click();
  await page.locator("#system").waitFor();
  await page
    .locator("#system .spatial-nodes")
    .getByRole("button", { name: "Evidenz", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Messwerte öffnen", exact: true })
    .click();
  await page.locator("#metrics").waitFor();
  assert.equal((await activeNavigationVisible()).trim(), "Messwerte");
  await page.goBack();
  await page.locator("#system").waitFor();
  assert.equal((await activeNavigationVisible()).trim(), "Dashboard");
  await page.goForward();
  await page.locator("#metrics").waitFor();
  assert.equal((await activeNavigationVisible()).trim(), "Messwerte");
  check(
    "Map navigation and browser back/forward keep the active mobile route visible",
  );
  await lineNavigation("Worker");
  const workerButton = page.locator("[data-worker-id]").first();
  await workerButton.waitFor();
  const workerId = await workerButton.getAttribute("data-worker-id");
  await workerButton.focus();
  await page.keyboard.press("Enter");
  await page.locator("#worker-detail-heading").waitFor();
  await page.getByRole("button", { name: "Zur Liste", exact: true }).click();
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-worker-id") === id,
    workerId,
  );
  await page.keyboard.press("Tab");
  check("Worker detail closes to its original keyboard trigger");
  await lineNavigation("Aufträge");
  const taskButton = page.locator("[data-task-id]").first();
  await taskButton.waitFor();
  const taskId = await taskButton.getAttribute("data-task-id");
  await taskButton.focus();
  await page.keyboard.press("Enter");
  await page.locator("#task-detail-heading").waitFor();
  await page
    .locator('section[aria-labelledby="task-detail-heading"]')
    .getByRole("button", { name: "Schließen", exact: true })
    .click();
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-task-id") === id,
    taskId,
  );
  // Allow the route refresh to settle, so a delayed heading focus cannot steal it back.
  await page.waitForFunction(
    () =>
      document.querySelector("#tasks")?.getAttribute("aria-busy") === "false",
  );
  assert.equal(
    await page.evaluate(() =>
      document.activeElement?.getAttribute("data-task-id"),
    ),
    taskId,
  );
  check("Task detail closes to its task card after the route refresh");
  // Fixture only the active assignment and delayed lookup; persisted tasks come from the real API.
  await page.route("**/v1/workers/*", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.activeTasks = [
      {
        id: taskA.id,
        status: "running",
        attempt: 1,
        expiresAt: Date.now() + 60000,
        profile: data.profiles[0]?.id ?? null,
      },
    ];
    data.activeTasksTruncated = false;
    await route.fulfill({ response, json: data });
  });
  await lineNavigation("Worker");
  await page.locator("[data-worker-id]").first().click();
  await page
    .locator("#workers .spatial-nodes")
    .getByRole("button", {
      name: "Auftrag " + taskA.id.slice(0, 8),
      exact: true,
    })
    .click();
  const { promise: held, resolve: release } = Promise.withResolvers();
  await page.route(
    new URL("/v1/tasks/" + taskA.id, lineUrl).href,
    async (route) => {
      await held;
      await route.continue();
    },
  );
  await page
    .getByRole("button", { name: "Auftragsereignisse öffnen", exact: true })
    .click();
  const alternate = page.locator(
    "[data-task-id=" + JSON.stringify(taskB.id) + "]",
  );
  await alternate.waitFor();
  // Select by exact DOM attribute to remain unambiguous when task titles repeat.
  await alternate.focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    (id) =>
      location.hash.includes("task=" + encodeURIComponent(id)) &&
      document.querySelector("#task-detail-heading"),
    taskB.id,
  );
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/v1/tasks/" + taskA.id,
  );
  release(undefined);
  await reply;
  await page.waitForFunction(
    () =>
      document.querySelector("#tasks")?.getAttribute("aria-busy") === "false",
  );
  assert.equal(
    new URLSearchParams(
      (await page.evaluate(() => location.hash)).split("?")[1],
    ).get("task"),
    taskB.id,
  );
  assert.match(
    await page.locator("#task-detail-heading").textContent(),
    new RegExp(taskB.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  check("Delayed active-task lookup cannot replace a newer task selection");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
    "No page-wide horizontal overflow",
  );
  assert.deepEqual(errors, []);
  if (process.env.WERK_VISUAL_REPORT)
    await writeFile(
      process.env.WERK_VISUAL_REPORT,
      JSON.stringify({ checks, errors }, null, 2),
    );
  console.log(JSON.stringify({ checks, errors }));
} finally {
  await browser.close();
}
