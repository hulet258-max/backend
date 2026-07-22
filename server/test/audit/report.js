const fs = require("node:fs");
const path = require("node:path");

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };

class AuditReport {
  constructor(options = {}) {
    this.startedAt = new Date().toISOString();
    this.options = options;
    this.checks = [];
    this.findings = [];
    this.metrics = {};
    this.notes = [];
  }

  check(name, passed, details = {}, severity = "high") {
    const item = { name, passed: Boolean(passed), severity, details, at: new Date().toISOString() };
    this.checks.push(item);
    if (!item.passed) {
      this.findings.push({
        id: `MG-${String(this.findings.length + 1).padStart(3, "0")}`,
        severity,
        title: name,
        details,
      });
    }
    return item.passed;
  }

  note(message, details = {}) {
    this.notes.push({ message, details, at: new Date().toISOString() });
  }

  metric(name, value) {
    this.metrics[name] = value;
  }

  summary() {
    const failed = this.checks.filter((item) => !item.passed);
    return {
      checks: this.checks.length,
      passed: this.checks.length - failed.length,
      failed: failed.length,
      critical: this.findings.filter((item) => item.severity === "critical").length,
      high: this.findings.filter((item) => item.severity === "high").length,
      medium: this.findings.filter((item) => item.severity === "medium").length,
      low: this.findings.filter((item) => item.severity === "low").length,
    };
  }

  toJSON() {
    return {
      audit: "managed-game-reliability",
      startedAt: this.startedAt,
      completedAt: new Date().toISOString(),
      options: this.options,
      summary: this.summary(),
      metrics: this.metrics,
      findings: this.findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]),
      checks: this.checks,
      notes: this.notes,
    };
  }

  toMarkdown() {
    const data = this.toJSON();
    const lines = [
      "# Managed Game Reliability Audit",
      "",
      `Generated: ${data.completedAt}`,
      "",
      "## Summary",
      "",
      `- Checks: ${data.summary.checks}`,
      `- Passed: ${data.summary.passed}`,
      `- Failed: ${data.summary.failed}`,
      `- Critical: ${data.summary.critical}`,
      `- High: ${data.summary.high}`,
      `- Medium: ${data.summary.medium}`,
      `- Low: ${data.summary.low}`,
      "",
      "## Findings",
      "",
    ];
    if (!data.findings.length) lines.push("No invariant failures were observed.", "");
    for (const finding of data.findings) {
      lines.push(
        `### ${finding.id} — ${finding.title}`,
        "",
        `Severity: **${finding.severity.toUpperCase()}**`,
        "",
        "```json",
        JSON.stringify(finding.details, null, 2),
        "```",
        ""
      );
    }
    lines.push("## Metrics", "", "```json", JSON.stringify(data.metrics, null, 2), "```", "");
    lines.push("## Notes", "");
    for (const note of data.notes) lines.push(`- ${note.message}: \`${JSON.stringify(note.details)}\``);
    return `${lines.join("\n")}\n`;
  }

  write(serverRoot) {
    const resultsDir = path.join(serverRoot, "test-results");
    fs.mkdirSync(resultsDir, { recursive: true });
    fs.writeFileSync(
      path.join(resultsDir, "managed-game-audit.json"),
      `${JSON.stringify(this.toJSON(), null, 2)}\n`
    );
    fs.writeFileSync(path.join(serverRoot, "MANAGED_GAME_AUDIT.md"), this.toMarkdown());
  }
}

module.exports = { AuditReport };

