import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { CreateTemplateDto, UpdateTemplateDto } from '../interfaces/template.interface';

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new HTTP400Error({ message });
}

/** Validate request structure locally; Meta remains authoritative for policy and specialized templates. */
export function validateTemplatePayload(data: CreateTemplateDto | UpdateTemplateDto, create = false) {
  requireValue(data && typeof data === 'object' && !Array.isArray(data), 'Template body must be an object');
  if (create) {
    const input = data as CreateTemplateDto;
    requireValue(typeof input.name === 'string' && /^[a-z0-9_]{1,512}$/.test(input.name),
      'Template name must contain 1?512 lowercase letters, digits or underscores');
    requireValue(typeof input.language === 'string' && /^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(input.language),
      'Provide one Meta language code, such as en_US, hi or mr; create each translation separately');
    requireValue(input.category, 'Template category is required');
    requireValue(input.components, 'Template components are required');
    requireValue(!input.parameter_format || ['POSITIONAL', 'NAMED'].includes(input.parameter_format),
      'parameter_format must be POSITIONAL or NAMED');
  } else {
    const allowed = ['category', 'components', 'message_send_ttl_seconds'];
    requireValue(Object.keys(data).length > 0, 'Provide category, components or message_send_ttl_seconds');
    requireValue(Object.keys(data).every(key => allowed.includes(key)),
      'Updates accept only category, components and message_send_ttl_seconds; name and language cannot change');
  }
  if (data.category !== undefined) requireValue(['MARKETING', 'UTILITY', 'AUTHENTICATION'].includes(data.category), 'Invalid template category');
  if (data.message_send_ttl_seconds !== undefined) requireValue(Number.isInteger(data.message_send_ttl_seconds) && data.message_send_ttl_seconds > 0,
    'message_send_ttl_seconds must be a positive integer; Meta enforces category-specific limits');
  if (data.components !== undefined) {
    requireValue(Array.isArray(data.components) && data.components.length > 0, 'components must be a nonempty array');
    const seen = new Set<string>();
    for (const component of data.components) {
      requireValue(component && typeof component === 'object' && typeof component.type === 'string', 'Each component requires a type');
      requireValue(!seen.has(component.type), `Duplicate component: ${component.type}`);
      seen.add(component.type);
      if (component.text !== undefined) requireValue(typeof component.text === 'string' && component.text.trim().length > 0, 'Component text must be a nonempty string');
      if (typeof component.text === 'string') {
        const limit = component.type === 'BODY' ? 1024 : ['HEADER', 'FOOTER'].includes(component.type) ? 60 : undefined;
        if (limit) requireValue(Array.from(component.text).length <= limit, `${component.type} text exceeds ${limit} characters`);
        const variables = [...new Set([...component.text.matchAll(/{{([^{}]+)}}/g)].map(match => match[1]))];
        if (variables.length && ['BODY', 'HEADER'].includes(component.type)) {
          const example = component.example;
          const named = variables.some(variable => !/^\d+$/.test(variable));
          if (!named) {
            requireValue(variables.every((variable, index) => variable === String(index + 1)), 'Positional variables must start at {{1}} and be sequential');
            const samples = component.type === 'BODY' ? example?.body_text : [example?.header_text];
            requireValue(Array.isArray(samples) && samples.length > 0 && samples.every((row: unknown) =>
              Array.isArray(row) && row.length === variables.length && row.every(value => typeof value === 'string' && value.length > 0)),
              `Provide example values for every ${component.type} variable`);
          } else {
            requireValue(variables.every(variable => /^[a-z_][a-z0-9_]*$/.test(variable)), 'Named variables must use lowercase names; do not mix named and positional variables');
            const samples = component.type === 'BODY' ? example?.body_text_named_params : example?.header_text_named_params;
            requireValue(Array.isArray(samples) && variables.every(variable => samples.some((sample: any) =>
              sample?.param_name === variable && typeof sample.example === 'string' && sample.example.length > 0)),
              `Provide named example values for every ${component.type} variable`);
          }
        }
        if (component.type === 'FOOTER') requireValue(variables.length === 0, 'Footer text cannot contain variables');
      }
      if (component.type === 'HEADER' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(component.format || '')) {
        requireValue(Array.isArray(component.example?.header_handle) && component.example.header_handle.length > 0 &&
          component.example.header_handle.every((handle: unknown) => typeof handle === 'string' && handle.length > 0),
          'Media header requires example.header_handle from Meta resumable upload');
      }
      if (component.buttons !== undefined) requireValue(Array.isArray(component.buttons) && component.buttons.length > 0, 'buttons must be a nonempty array');
    }
    requireValue(seen.has('BODY'), 'Provide the complete components array including BODY');
  }
}
