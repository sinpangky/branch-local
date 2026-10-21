/** Deterministic, self-contained PDF fixture; no external font or network resources. */
export function tinyMaterialPdf(pages = [{ lines: ["Local PDF material", "Second line"] }]) {
  const imageId = 4 + pages.length * 2;
  const usesImage = pages.some((page) => page.image);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_page, index) => `${4 + index * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let index = 0; index < pages.length; index++) {
    const { lines = [], image = false, fontSize = 12 } = pages[index];
    const content = image ? "q 100 0 0 100 50 50 cm /Im1 Do Q" : [
      `BT /F1 ${fontSize} Tf 50 780 Td`,
      ...lines.flatMap((line, index) => [
        ...(index ? ["0 -16 Td"] : []),
        `(${line.replace(/[\\()]/g, "\\$&")}) Tj`,
      ]),
      "ET",
    ].join("\n");
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> ${image ? `/XObject << /Im1 ${imageId} 0 R >>` : ""} >> /Contents ${5 + index * 2} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }
  if (usesImage) objects.push("<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 1 >>\nstream\nX\nendstream");
  let content = "%PDF-1.7\n% local fixture\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(content));
    content += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}
