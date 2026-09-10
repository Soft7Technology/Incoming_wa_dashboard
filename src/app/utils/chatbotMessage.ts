export function validateChatbotMessage(data: any): void {
  const message = data?.attributes?.message;
  if (data?.key === '@whatsapp/send-text-message') {
    if (typeof message?.text?.body !== 'string' || !message.text.body.trim()) {
      throw new Error('Text message node requires attributes.message.text.body.');
    }
  }
  if (data?.key !== '@whatsapp/send-list-message') return;
  const sections = message?.interactive?.action?.sections;
  if (!Array.isArray(sections) || !sections.length) throw new Error('List message requires at least one section with an option.');
  for (const [sectionIndex, section] of sections.entries()) {
    if (!Array.isArray(section?.rows) || !section.rows.length) throw new Error(`List section ${sectionIndex + 1} requires at least one option.`);
    for (const [rowIndex, row] of section.rows.entries()) {
      if (typeof row?.title !== 'string' || !row.title.trim()) {
        throw new Error(`List section ${sectionIndex + 1}, option ${rowIndex + 1}: title is required.`);
      }
      if (typeof row?.id !== 'string' || !row.id.trim()) {
        throw new Error(`List section ${sectionIndex + 1}, option ${rowIndex + 1}: id is required.`);
      }
    }
  }
}
