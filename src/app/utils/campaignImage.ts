import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export const CAMPAIGN_IMAGE_VARIABLE = 'header_image_url';

export function validateCampaignImageUrl(value: unknown, contactId?: string): string {
  if (typeof value === 'string' && value.trim() && !/\s/.test(value.trim())) {
    try {
      const url = new URL(value.trim());
      if (['http:', 'https:'].includes(url.protocol) && url.hostname && !url.username && !url.password) {
        return value.trim();
      }
    } catch { /* Report the same actionable validation error for all invalid URLs. */ }
  }
  throw new HTTP400Error({
    message: `Provide a valid HTTP(S) image URL${contactId ? ` for contact ${contactId}` : ''}, or configure an image fallback URL.`,
    details: {
      code: 'CAMPAIGN_IMAGE_URL_INVALID',
      field: `parameter_mapping.${CAMPAIGN_IMAGE_VARIABLE}`,
      ...(contactId ? { contact_id: contactId } : {}),
    },
  });
}

/** Both campaign sends and test sends use the same image precedence. */
export function campaignHeaderImage(variables: Record<string, unknown>, mediaUploads: any[], component: any) {
  if (Object.prototype.hasOwnProperty.call(variables, CAMPAIGN_IMAGE_VARIABLE)) {
    return { link: validateCampaignImageUrl(variables[CAMPAIGN_IMAGE_VARIABLE]) };
  }
  const media = mediaUploads.find(media => media.type === 'image');
  if (media) return media.media_id ? { id: media.media_id } : { link: media.link || media.url };
  if (component.example?.header_handle?.[0]) return { link: component.example.header_handle[0] };
  return undefined;
}
