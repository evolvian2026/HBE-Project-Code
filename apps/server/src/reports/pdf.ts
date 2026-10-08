import PDFDocument from "pdfkit";
import type { GradeReport } from "./data.ts";

/**
 * Renders a grade report as an A4 PDF with PDFKit (pure JavaScript, so the app host needs no
 * browser). The PDF's standard fonts cover Western European text (Windows-1252); other
 * characters are replaced, and the JSON record keeps the exact text.
 */

// Windows-1252 characters outside Latin-1, which the standard fonts can draw.
const CP1252_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const REPLACEMENTS: Record<string, string> = { "−": "-", "✓": "v", "✗": "x", "→": "->", "≤": "<=", "≥": ">=" };

export function pdfText(text: string | null | undefined): string {
  let out = "";
  for (const ch of text ?? "") {
    const code = ch.codePointAt(0)!;
    if (code === 10 || (code >= 32 && code < 127) || (code >= 160 && code <= 255) || CP1252_EXTRA.has(ch)) out += ch;
    else out += REPLACEMENTS[ch] ?? (code === 9 ? "  " : "?");
  }
  return out;
}

/** Markdown to plain paragraphs: headings, emphasis and links reduced to text. */
function markdownToText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```\w*\n?/g, ""))
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*(?!\s)(.+?)\*/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

const fmt = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : n.toLocaleString("en", { maximumFractionDigits: 2 });

function dateIn(iso: string | null, timeZone: string): string {
  if (!iso) return "–";
  return new Intl.DateTimeFormat("en-SG", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(iso));
}

export async function renderGradeReportPdf(report: GradeReport, sha256: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: pdfText(`Grade report: ${report.assignment.title}`),
      Author: "HBE Projects",
      Subject: pdfText(`${report.course.code} ${report.course.name}`),
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on("end", () => resolve(Buffer.concat(chunks))));

  const tz = report.course.timezone;
  const width = doc.page.width - 100;
  const heading = (text: string) => {
    doc.moveDown(0.8).font("Helvetica-Bold").fontSize(12).fillColor("#111").text(pdfText(text));
    doc.moveDown(0.2).font("Helvetica").fontSize(10).fillColor("#222");
  };
  const line = (label: string, value: string) =>
    doc
      .font("Helvetica-Bold")
      .text(`${pdfText(label)}: `, { continued: true })
      .font("Helvetica")
      .text(pdfText(value));
  const muted = (text: string) => doc.fillColor("#555").text(pdfText(text)).fillColor("#222");

  // Title
  doc.font("Helvetica-Bold").fontSize(18).text("Grade report");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#444")
    .text(pdfText(`${report.institution.name} · ${report.course.code} ${report.course.name} (${report.course.term})`))
    .text(pdfText(report.assignment.title))
    .fillColor("#222")
    .fontSize(10);

  heading("Student");
  line("Name", report.student.name ?? report.student.email ?? "–");
  if (report.student.student_id) line("Student ID", report.student.student_id);
  if (report.student.email) line("Email", report.student.email);
  if (report.student.github_login) line("GitHub", `@${report.student.github_login}`);

  heading("Submission");
  line("Due", dateIn(report.assignment.effective_due_at, tz) + (report.assignment.extension ? " (extended)" : ""));
  if (report.submission.graded_commit) {
    line("Graded commit", report.submission.graded_commit);
    line("Pushed", dateIn(report.submission.pushed_at, tz));
    if (report.submission.repository) line("Repository", report.submission.repository);
  } else {
    line("Graded commit", "nothing was pushed before the cutoff");
  }
  if (report.submission.late_days) line("Late", `${report.submission.late_days} day(s)`);
  if (report.submission.snapshot) line("Archived source (SHA-256)", report.submission.snapshot.tarball_sha256);
  line(
    "Stack",
    `${report.assignment.stack_profile}${report.assignment.suite ? ` · tests ${report.assignment.suite}` : ""}`,
  );

  heading("Grade");
  doc
    .font("Helvetica-Bold")
    .fontSize(22)
    .text(`${fmt(report.grade.final)} / 100`);
  doc.font("Helvetica").fontSize(10);
  const components = report.grade.components as {
    automated?: { weight: number; score: number | null; points: number };
    rubric?: { weight: number; score: number | null; points: number };
    process?: { weight: number; score: number | null; points: number };
  };
  for (const [key, label] of [
    ["automated", "Automated tests"],
    ["rubric", "Rubric"],
    ["process", "Process (activity)"],
  ] as const) {
    const c = components[key];
    if (!c || c.weight === 0) continue;
    line(label, `${fmt(c.score)} / 100 × ${c.weight}% = ${fmt(c.points)}`);
  }
  if (report.grade.late_penalty_percent > 0) {
    line("Late penalty", `−${fmt(report.grade.late_penalty_percent)}% → ${fmt(report.grade.computed)}`);
  }
  if (report.grade.adjusted_by_staff) {
    line("Adjusted by staff", `${fmt(report.grade.final)} (calculated ${fmt(report.grade.computed)})`);
  }

  if (report.rubric.length) {
    heading("Rubric");
    for (const r of report.rubric) {
      line(r.criterion, `${fmt(r.points)} / ${fmt(r.max_points)}`);
      if (r.comment) muted(r.comment);
    }
  }

  if (report.feedback_md.trim()) {
    heading("Feedback");
    doc.text(pdfText(markdownToText(report.feedback_md)), { width });
  }

  if (report.automated) {
    heading(`Automated tests${report.automated.score === null ? "" : `: ${fmt(report.automated.score)} / 100`}`);
    for (const s of report.automated.stages) {
      line(s.key, s.status);
      if (s.status === "failed" && s.message) muted(s.message.slice(0, 1500));
    }
    const failed = report.automated.tests.filter((t) => t.status === "failed" || t.status === "error");
    const passed = report.automated.tests.filter((t) => t.status === "passed").length;
    doc.moveDown(0.3).text(`${passed} of ${report.automated.tests.length} tests passed.`);
    for (const t of failed) {
      doc
        .moveDown(0.3)
        .font("Helvetica-Bold")
        .text(pdfText(`Failed: ${t.title}${t.category ? ` (${t.category})` : ""}`));
      doc.font("Helvetica");
      if (t.message) doc.text(pdfText(t.message), { width });
      if (t.expected || t.actual) muted(`Expected ${t.expected ?? "–"}; got ${t.actual ?? "–"}`);
      if (t.hint) muted(`Hint: ${t.hint}`);
    }
  }

  if (report.process) {
    heading(`Process: ${fmt(report.process.score)} / 100`);
    for (const c of report.process.criteria) {
      line(c.label, `${fmt(c.points)} points`);
      muted(c.explanation);
    }
  }

  doc
    .moveDown(1.5)
    .fontSize(8)
    .fillColor("#666")
    .text(
      pdfText(
        `Report version ${report.report.version} (grade version ${report.report.grade_version}), generated ${dateIn(report.report.generated_at, tz)}. ` +
          `SHA-256 of the JSON record: ${sha256}`,
      ),
      { width },
    );
  doc.end();
  return done;
}
