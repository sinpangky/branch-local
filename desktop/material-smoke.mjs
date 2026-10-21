import path from 'node:path';
import { writeFile, unlink } from 'node:fs/promises';
import { readMaterialDocuments } from './materials.mjs';

/** Validate packaged PDF.js and its local resources without opening a picker or using a provider. */
export async function checkMaterialRuntime(directory) {
  const text='Packaged local PDF extraction';
  const stream=`BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [4 0 R] /Count 1 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf='%PDF-1.7\n',offsets=[];
  for(let index=0;index<objects.length;index++){offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${objects[index]}\nendobj\n`;}
  const start=Buffer.byteLength(pdf);
  pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.map((offset)=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  const filename=path.join(directory,`runtime-material-${crypto.randomUUID()}.pdf`);
  try {
    await writeFile(filename,pdf);
    const documents=await readMaterialDocuments([filename]);
    if(documents[0]?.kind!=='pdf'||documents[0]?.parts[0]?.page!==1||!documents[0].parts[0].text.includes(text))throw new Error('Packaged PDF text extraction failed');
    return true;
  }finally{await unlink(filename).catch(()=>{});}
}
