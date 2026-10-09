// Media nodes and the sender must use the same type-specific payload.
export function buildChatbotMediaMessage(message: any): any {
  const type = message?.type;
  if (!['image', 'video', 'audio', 'document', 'sticker'].includes(type)) {
    throw new Error('Media message must be image, video, audio, document, or sticker.');
  }
  const media = message[type];
  const id = typeof media?.id === 'string' ? media.id.trim() : '';
  const link = typeof media?.link === 'string' ? media.link.trim() : '';
  if ((!id && !link) || (id && link)) {
    throw new Error(`Media ${type} message requires either a media id or link.`);
  }
  const payload: any = id ? { id } : { link };
  if (['image', 'video', 'document'].includes(type) && typeof media.caption === 'string') {
    payload.caption = media.caption;
  }
  if (type === 'document' && typeof media.filename === 'string' && media.filename.trim()) {
    payload.filename = media.filename;
  }
  return { type, [type]: payload };
}

export function buildInteractiveHeader(header: any): any | undefined {
  if (!header?.type || header.type === 'none') return undefined;
  if (header.type === 'text') {
    return typeof header.text === 'string' && header.text.trim()
      ? { type: 'text', text: header.text }
      : undefined;
  }
  if (!['image', 'video', 'document'].includes(header.type)) {
    throw new Error('Interactive header must be text, image, video, or document.');
  }

  const media = header[header.type];
  const id = typeof media?.id === 'string' ? media.id.trim() : '';
  const link = typeof media?.link === 'string' ? media.link.trim() : '';
  if ((!id && !link) || (id && link)) {
    throw new Error(`Interactive ${header.type} header requires either a media id or link.`);
  }
  return { type: header.type, [header.type]: id ? { id } : { link } };
}

export function validateChatbotMessage(data: any): void {
  const message = data?.attributes?.message;
  if (data?.key === '@whatsapp/send-media-message') {
    buildChatbotMediaMessage(message);
  }
  if (data?.key === '@whatsapp/send-button-message') {
    const buttons = data?.attributes ? message?.interactive?.action?.buttons : data?.buttons;
    if (!Array.isArray(buttons) || !buttons.length) {
      throw new Error('Button message requires at least one button.');
    }
    for (const [index, button] of buttons.entries()) {
      const title = button?.reply?.title ?? button?.title ?? (typeof button === 'string' ? button : '');
      if (typeof title !== 'string' || !title.trim()) {
        throw new Error(`Button ${index + 1}: title is required.`);
      }
    }
  }
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
