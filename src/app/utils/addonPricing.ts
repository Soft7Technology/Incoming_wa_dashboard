import HTTP400Error from '@surefy/exceptions/HTTP400Error';

export function addonMarkup(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 100000000)
    throw new HTTP400Error({ message: 'markup_paise must be an integer between 0 and 100000000' });
  return value;
}

/** The catalog price is the platform cost; markup belongs to the selling company. */
export function addonPrice(addon: any, markup = 0, quantity = 1) {
  const base = Number(addon.price_paise);
  addonMarkup(markup);
  if (!Number.isSafeInteger(base) || base <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0)
    throw new HTTP400Error({ message: 'Invalid saved add-on pricing' });
  const platform_fee_paise = base * quantity;
  const markup_paise = markup * quantity;
  const total_price_paise = platform_fee_paise + markup_paise;
  if (!Number.isSafeInteger(total_price_paise)) throw new HTTP400Error({ message: 'Add-on price exceeds supported limits' });
  return { platform_fee_paise, markup_paise, total_price_paise };
}
