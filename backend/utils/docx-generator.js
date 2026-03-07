const {
  Document, Paragraph, TextRun, ExternalHyperlink,
  TabStopType, AlignmentType, BorderStyle, LevelFormat,
  Packer, PageOrientation,
} = require('docx');

const NAVY = "1B3A6B";
const BLUE = "1A6EB5";
const DARK = "1A1A1A";
const BODY = "333333";
const GRAY = "777777";

/**
 * Parse text with **bold** markers into an array of TextRun objects.
 */
function parseRuns(text, { color = BODY, size = 17, boldColor = DARK } = {}) {
  const runs = [];
  const regex = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      runs.push(new TextRun({
        text: text.slice(lastIndex, match.index),
        font: "Calibri",
        color,
        size,
      }));
    }
    runs.push(new TextRun({
      text: match[1],
      font: "Calibri",
      bold: true,
      color: boldColor,
      size,
    }));
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    runs.push(new TextRun({
      text: text.slice(lastIndex),
      font: "Calibri",
      color,
      size,
    }));
  }

  return runs.length > 0 ? runs : [new TextRun({ text, font: "Calibri", color, size })];
}

function divider(before = 30, after = 30) {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 10, space: 1, color: NAVY } },
    spacing: { before, after },
    children: [],
  });
}

function sectionHeader(label) {
  return new Paragraph({
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, space: 1, color: NAVY } },
    spacing: { before: 55, after: 0 },
    children: [
      new TextRun({
        text: label,
        font: "Calibri",
        bold: true,
        allCaps: true,
        color: NAVY,
        characterSpacing: 50,
        size: 19,
      }),
    ],
  });
}

function jobHeader(company, role, dateLocation) {
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
    spacing: { before: 55, after: 0 },
    children: [
      new TextRun({ text: company, font: "Calibri", bold: true, color: NAVY, size: 18 }),
      new TextRun({ text: "  " + role, font: "Calibri", color: BODY, size: 17 }),
      new TextRun({ text: "\t" + dateLocation, font: "Calibri", color: GRAY, size: 16, italics: true }),
    ],
  });
}

function bullet(text) {
  return new Paragraph({
    numbering: { reference: "bullets", level: 0 },
    spacing: { before: 18, after: 0 },
    children: parseRuns(text, { color: BODY, size: 17 }),
  });
}

function sep() {
  return new TextRun({ text: "  |  ", font: "Calibri", color: GRAY, size: 17 });
}

/**
 * Generate a .docx resume buffer from structured JSON data.
 */
async function generateResume(data) {
  const children = [];

  // ── Header (centered) ──
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 0 },
    children: [
      new TextRun({
        text: data.name,
        font: "Calibri",
        bold: true,
        size: 38,
        color: NAVY,
        characterSpacing: 80,
      }),
    ],
  }));

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 0 },
    children: [
      new TextRun({
        text: data.tagline,
        font: "Calibri",
        italics: true,
        size: 18,
        color: GRAY,
      }),
    ],
  }));

  // Contact line
  const contactRuns = [];
  const c = data.contact;

  if (c.email) {
    contactRuns.push(new ExternalHyperlink({
      children: [new TextRun({ text: c.email, font: "Calibri", color: BLUE, size: 17 })],
      link: `mailto:${c.email}`,
    }));
  }
  if (c.linkedin) {
    if (contactRuns.length) contactRuns.push(sep());
    contactRuns.push(new ExternalHyperlink({
      children: [new TextRun({ text: c.linkedin.display, font: "Calibri", color: BLUE, size: 17 })],
      link: c.linkedin.url,
    }));
  }
  if (c.github) {
    if (contactRuns.length) contactRuns.push(sep());
    contactRuns.push(new ExternalHyperlink({
      children: [new TextRun({ text: c.github.display, font: "Calibri", color: BLUE, size: 17 })],
      link: c.github.url,
    }));
  }
  if (c.location) {
    if (contactRuns.length) contactRuns.push(sep());
    contactRuns.push(new TextRun({ text: c.location, font: "Calibri", color: GRAY, size: 17 }));
  }

  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 0, after: 0 },
    children: contactRuns,
  }));

  // Divider after header
  children.push(divider(30, 30));

  // ── Summary ──
  children.push(new Paragraph({
    spacing: { before: 0, after: 0 },
    children: parseRuns(data.summary, { color: BODY, size: 18, boldColor: DARK }),
  }));

  // Divider between summary and competencies
  children.push(divider(10, 10));

  // ── Core Competencies ──
  children.push(sectionHeader("Core Competencies"));
  (data.competencies || []).forEach((comp, i) => {
    children.push(new Paragraph({
      spacing: { before: i === 0 ? 20 : 18, after: 0 },
      children: [
        new TextRun({ text: comp.label + ": ", font: "Calibri", bold: true, color: NAVY, size: 17 }),
        ...parseRuns(comp.content, { color: BODY, size: 17 }),
      ],
    }));
  });

  // ── Professional Experience ──
  children.push(sectionHeader("Professional Experience"));
  for (const job of (data.experience || [])) {
    children.push(jobHeader(job.company, job.role, job.dateLocation));
    for (const b of (job.bullets || [])) {
      children.push(bullet(b));
    }
  }

  // ── Education ──
  children.push(sectionHeader("Education"));
  for (const edu of (data.education || [])) {
    children.push(new Paragraph({
      tabStops: [{ type: TabStopType.RIGHT, position: 9360 }],
      spacing: { before: 20, after: 0 },
      children: [
        new TextRun({ text: edu.degree, font: "Calibri", bold: true, color: DARK, size: 17 }),
        new TextRun({ text: "  " + edu.school, font: "Calibri", color: BODY, size: 17 }),
        new TextRun({ text: "\t" + edu.date, font: "Calibri", color: GRAY, size: 16, italics: true }),
      ],
    }));
    if (edu.coursework) {
      children.push(new Paragraph({
        spacing: { before: 12, after: 0 },
        children: [
          new TextRun({
            text: "Relevant Coursework: " + edu.coursework,
            font: "Calibri",
            italics: true,
            color: GRAY,
            size: 16,
          }),
        ],
      }));
    }
  }

  // ── Awards & Open-Source ──
  if (data.awards && data.awards.length > 0) {
    children.push(sectionHeader("Awards & Open-Source"));
    for (const award of data.awards) {
      children.push(new Paragraph({
        spacing: { before: 18, after: 0 },
        children: parseRuns(award, { color: BODY, size: 17 }),
      }));
    }
  }

  // Build document
  const doc = new Document({
    numbering: {
      config: [{
        reference: "bullets",
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: "\u2022",
          alignment: AlignmentType.LEFT,
          style: {
            paragraph: {
              indent: { left: 360, hanging: 220 },
              spacing: { before: 20, after: 0 },
            },
          },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: {
            width: 12240,
            height: 15840,
            orientation: PageOrientation.PORTRAIT,
          },
          margin: {
            top: 648,
            bottom: 648,
            left: 864,
            right: 864,
          },
        },
      },
      children,
    }],
  });

  return await Packer.toBuffer(doc);
}

module.exports = { generateResume };
