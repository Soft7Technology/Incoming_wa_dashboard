import { fail, object } from './automationFlow';

type Variable = { key: string; type: 'text' | 'url'; description?: string };

/** One renderer drives both the editor's fields and the message sent to Meta. */
function build(template: any, value: (field: Variable) => string) {
  if (!Array.isArray(template.components) || !template.components.some((part: any) => part.type?.toUpperCase() === 'BODY'))
    fail(400, 'The template must contain a body');
  const components: any[] = [];
  const placeholders = (input: unknown) => [...new Set(Array.from(String(input || '').matchAll(/{{\s*([\w]+)\s*}}/g), match => match[1]))];
  for (const part of template.components) {
    const type = String(part.type).toLowerCase();
    if (type === 'buttons') {
      for (const [index, button] of (part.buttons || []).entries()) {
        const buttonType = String(button.type).toUpperCase();
        if (buttonType === 'URL') {
          const keys = placeholders(button.url);
          if (keys.length > 1) fail(400, 'URL buttons support one dynamic suffix');
          if (keys.length) components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [
            { type: 'text', text: value({ key: `button.${index}.${keys[0]}`, type: 'text', description: 'The dynamic suffix of the approved button URL.' }) },
          ] });
        } else if (!['PHONE_NUMBER', 'QUICK_REPLY'].includes(buttonType)) fail(400, `Unsupported automation template button: ${buttonType}`);
      }
      continue;
    }
    if (type === 'header' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(String(part.format).toUpperCase())) {
      const mediaType = String(part.format).toLowerCase();
      const link = value({ key: 'header.media_url', type: 'url', description: `Public HTTPS URL for the ${mediaType} header.` });
      let url: URL;
      try { url = new URL(link); } catch { return fail(400, 'header.media_url must be a plain HTTPS URL'); }
      if (url.protocol !== 'https:' || url.username || url.password) fail(400, 'header.media_url must be a plain HTTPS URL');
      components.push({ type: 'header', parameters: [{ type: mediaType, [mediaType]: { link } }] });
      continue;
    }
    if (!['header', 'body', 'footer'].includes(type) || (type === 'header' && part.format && String(part.format).toUpperCase() !== 'TEXT'))
      fail(400, `Unsupported automation template component: ${part.format || part.type}`);
    const keys = placeholders(part.text);
    if (type === 'footer' && keys.length) fail(400, 'Template footers must be static');
    // Positional parameters must be sent by position, even if text mentions {{2}} first.
    if (keys.every(key => /^\d+$/.test(key))) keys.sort((a, b) => Number(a) - Number(b));
    const parameters = keys.map(key => ({ type: 'text', text: value({ key: `${type}.${key}`, type: 'text' }),
      ...(/^\d+$/.test(key) ? {} : { parameter_name: key }),
    }));
    if (parameters.length) components.push({ type, parameters });
  }
  return { name: template.name, language: template.language, components };
}

export function automationTemplateFields(template: any): Variable[] {
  const fields: Variable[] = [];
  build(template, field => { fields.push(field); return field.type === 'url' ? 'https://example.com/media' : 'Preview'; });
  return fields;
}

export function renderAutomationTemplate(template: any, input: unknown = {}) {
  const variables = object(input), used = new Set<string>();
  const rendered = build(template, field => {
    used.add(field.key);
    const value = Object.prototype.hasOwnProperty.call(variables, field.key) ? variables[field.key] : undefined;
    if (!['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || !String(value).trim() || String(value).length > 1024)
      fail(400, `Provide variables["${field.key}"] as non-empty text (maximum 1024 characters)`);
    return String(value);
  });
  if (Object.keys(variables).some(key => !used.has(key))) fail(400, 'Unknown template variable');
  return rendered;
}
