import { object, string } from '../finance/shopping-values.js';

export interface ProductPage {
  title: string;
  description: string;
  imageUrl?: string;
  imageUrls?: string[];
  amount?: string;
  currency?: string;
  availability?: string;
  priceNote?: string;
  specifications: Record<string, string>;
}

/** Core shopping-card evidence must come from a readable item page. */
export function isCompleteProduct(product?: Partial<ProductPage> | null): boolean {
  if (!product?.title?.trim() || !product.description?.trim()) return false;
  if (
    !product.amount ||
    !/^\d{1,13}(?:\.\d{1,2})?$/.test(product.amount) ||
    Number(product.amount) <= 0
  )
    return false;
  if (!/^[A-Z]{3}$/.test(product.currency ?? '')) return false;
  const stock = (product.availability ?? '')
    .split(/[/#]/)
    .pop()!
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!['instock', 'limitedavailability'].includes(stock)) return false;
  try {
    const image = new URL(product.imageUrl ?? '');
    if (image.protocol !== 'https:' || image.username || image.password) return false;
  } catch {
    return false;
  }
  return Object.entries(product.specifications ?? {}).some(
    ([key, value]) => key.trim() && typeof value === 'string' && value.trim(),
  );
}

/** Only explicit merchant stock signals can mark an item unavailable. */
export function isUnavailableProduct(availability?: string): boolean {
  const status = (availability ?? '')
    .split(/[/#]/)
    .pop()!
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  return [
    'outofstock',
    'soldout',
    'discontinued',
    'unavailable',
    'notavailable',
    'backorder',
    'preorder',
    'presale',
  ].includes(status);
}

function decode(value: string): string {
  const entities: Record<string, string> = {
    amp: '&',
    quot: '"',
    apos: "'",
    lt: '<',
    gt: '>',
    nbsp: ' ',
    rsquo: '’',
    lsquo: '‘',
    rdquo: '”',
    ldquo: '“',
    ndash: '–',
    mdash: '—',
  };
  let decoded = value;
  // Some storefronts encode their already-escaped catalog text again in JSON-LD.
  for (let pass = 0; pass < 3; pass++) {
    const next = decoded.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
      if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? match;
      const number =
        entity[1].toLowerCase() === 'x'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
    });
    if (next === decoded) break;
    decoded = next;
  }
  return decoded;
}
function plain(value: unknown): string {
  return decode(string(value))
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(?:p|div|li|h[1-6])>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/\\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n\n')
    .trim();
}

function sameItem(value: unknown, current: string): boolean {
  try {
    const item = new URL(string(value), current),
      page = new URL(current);
    return (
      item.origin === page.origin &&
      item.pathname.replace(/\/+$/, '') === page.pathname.replace(/\/+$/, '')
    );
  } catch {
    return false;
  }
}

function sameOffer(value: unknown, current: string): boolean {
  try {
    const normalize = (url: URL) => {
      url.hash = '';
      for (const key of Array.from(url.searchParams.keys()))
        if (/^(utm_|cid$|gclid$|fbclid$)/i.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      return url.href;
    };
    return normalize(new URL(string(value), current)) === normalize(new URL(current));
  } catch {
    return false;
  }
}

/** Accept unambiguous decimals and correctly grouped thousands only. */
function productPrice(
  amount: unknown,
  currency: unknown,
): { amount: string; currency: string } | undefined {
  const raw = scalar(amount),
    code = scalar(currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return undefined;
  if (!/^(?:\d{1,13}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(raw)) return undefined;
  const normalized = raw.replace(/,/g, '');
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) return undefined;
  return { amount: normalized, currency: code };
}

function scalar(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : plain(value);
}
function metadata(html: string): Map<string, string[]> {
  const tags = new Map<string, string[]>();
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attributes: Record<string, string> = {};
    for (const attr of match[0].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g))
      attributes[attr[1].toLowerCase()] = decode(attr[2] ?? attr[3]);
    const key = attributes.property ?? attributes.name;
    if (key && attributes.content) tags.set(key, [...(tags.get(key) ?? []), attributes.content]);
  }
  return tags;
}

/** Extract the primary item, rather than related items or category listings. */
export function parseProductPage(html: string, pageUrl?: string): ProductPage | null {
  const products: Record<string, unknown>[] = [];
  const references = new Map<string, Record<string, unknown>>();
  function visit(value: unknown, depth = 0) {
    if (depth > 12) return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
    } else if (value && typeof value === 'object') {
      const row = object(value);
      if (string(row['@id']) && Object.keys(row).length > 1)
        references.set(string(row['@id']), row);
      const types = Array.isArray(row['@type']) ? row['@type'] : [row['@type']];
      if (types.some((type) => type === 'Product' || type === 'https://schema.org/Product'))
        products.push(row);
      for (const key of ['@graph', 'mainEntity']) visit(row[key], depth + 1);
    }
  }
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json(?:\s*;[^"']*)?["'][^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    try {
      visit(JSON.parse(match[1]));
    } catch {
      /* Fall back to explicit product metadata. */
    }
  }
  const meta = metadata(html);
  const first = (key: string) => meta.get(key)?.[0] ?? '';
  const matches = pageUrl
    ? products.filter((product) =>
        [product.url, product['@id']].some((value) => string(value) && sameItem(value, pageUrl)),
      )
    : [];
  let product = matches.length === 1 ? matches[0] : products.length === 1 ? products[0] : undefined;
  if (
    product &&
    pageUrl &&
    (string(product.url) || string(product['@id'])) &&
    !matches.includes(product)
  )
    return null;
  if (
    !product &&
    products.length === 0 &&
    (meta.get('og:type')?.includes('product') || first('product:price:amount'))
  ) {
    product = { name: first('og:title'), description: first('og:description') };
  }
  if (!product || !string(product.name).trim()) return null;
  const resolve = (value: unknown) => references.get(string(object(value)['@id'])) ?? object(value);
  const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
  const resolvedOffers = offers.map(resolve);
  const availableOffers = resolvedOffers.filter(
    (value) => !isUnavailableProduct(string(value.availability)),
  );
  const matchingOffers = pageUrl
    ? availableOffers.filter((value) => string(value.url) && sameOffer(value.url, pageUrl))
    : [];
  const offer =
    (matchingOffers.length === 1 ? matchingOffers[0] : undefined) ??
    availableOffers.find((value) =>
      /^(instock|limitedavailability)$/i.test(string(value.availability).split(/[/#]/).pop() ?? ''),
    ) ??
    availableOffers[0] ??
    resolvedOffers[0] ??
    {};
  const offerPrice = (value: Record<string, unknown>) => {
    const pricing = object(value.priceSpecification);
    return value.price != null
      ? productPrice(value.price, value.priceCurrency)
      : string(pricing.priceType).includes('StrikethroughPrice')
        ? undefined
        : productPrice(pricing.price, pricing.priceCurrency ?? value.priceCurrency);
  };
  const selectedPrice = offerPrice(offer);
  const metaPrice = productPrice(first('product:price:amount'), first('product:price:currency'));
  const possiblePrices = new Set(
    availableOffers
      .map((value) => {
        const price = offerPrice(value);
        return price ? `${price.currency}:${Number(price.amount)}` : '';
      })
      .filter(Boolean),
  );
  const ambiguous = possiblePrices.size > 1 && matchingOffers.length !== 1;
  const conflict =
    selectedPrice &&
    metaPrice &&
    (selectedPrice.currency !== metaPrice.currency ||
      Number(selectedPrice.amount) !== Number(metaPrice.amount));
  const price =
    ambiguous || conflict
      ? undefined
      : (selectedPrice ??
        (offers.every((value) => !value || !Object.keys(object(value)).length)
          ? metaPrice
          : undefined));
  const priceNote = ambiguous
    ? 'Select product options at the merchant to confirm the price.'
    : conflict
      ? 'Merchant price sources disagree. Confirm the current price on the product page.'
      : undefined;
  const rawImages = [
    ...(Array.isArray(product.image) ? product.image : [product.image]),
    ...(meta.get('og:image') ?? []),
  ];
  const imageUrls = [
    ...new Set(
      rawImages.flatMap((image) => {
        const source =
          typeof image === 'string' ? image : string(object(image).url ?? object(image).contentUrl);
        if (!source) return [];
        try {
          const url = new URL(decode(source), pageUrl);
          return url.protocol === 'https:' && !url.username && !url.password
            ? [url.href.slice(0, 4000)]
            : [];
        } catch {
          return [];
        }
      }),
    ),
  ].slice(0, 8);
  const specifications: Record<string, string> = {};
  const add = (name: string, value: unknown) => {
    const text = scalar(value);
    if (text && Object.keys(specifications).length < 40)
      specifications[name.slice(0, 100)] = text.slice(0, 1000);
  };
  for (const key of [
    'sku',
    'mpn',
    'model',
    'color',
    'size',
    'material',
    'weight',
    'width',
    'height',
    'depth',
  ])
    add(key, product[key]);
  add(
    'brand',
    typeof product.brand === 'string'
      ? product.brand
      : (resolve(product.brand).name ?? first('product:brand')),
  );
  if (Array.isArray(product.additionalProperty)) {
    for (const raw of product.additionalProperty.slice(0, 30)) {
      const property = object(raw);
      if (string(property.name)) add(string(property.name), property.value);
    }
  }
  add('Seller', typeof offer.seller === 'string' ? offer.seller : resolve(offer.seller).name);
  add('Condition', string(offer.itemCondition).split('/').pop());
  const rating = object(product.aggregateRating);
  if (rating.ratingValue != null)
    add(
      'Rating',
      rating.bestRating != null
        ? `${scalar(rating.ratingValue)} / ${scalar(rating.bestRating)}`
        : scalar(rating.ratingValue),
    );
  add('Reviews', rating.reviewCount ?? rating.ratingCount);
  const returns = object(offer.hasMerchantReturnPolicy);
  if (returns.merchantReturnDays != null)
    add('Return period', `${scalar(returns.merchantReturnDays)} days`);
  const shipping = object(
    Array.isArray(offer.shippingDetails) ? offer.shippingDetails[0] : offer.shippingDetails,
  );
  const transit = object(object(shipping.deliveryTime).transitTime);
  if (transit.minValue != null && transit.maxValue != null)
    add(
      'Estimated shipping transit',
      `${scalar(transit.minValue)}–${scalar(transit.maxValue)} ${string(transit.unitCode) === 'DAY' ? 'days' : string(transit.unitCode)}`,
    );
  const metaAvailability = first('product:availability');
  const availability = isUnavailableProduct(metaAvailability)
    ? metaAvailability
    : string(offer.availability) || metaAvailability;
  return {
    title: plain(product.name).slice(0, 300),
    description: plain(product.description || first('og:description')).slice(0, 8000),
    ...(imageUrls.length ? { imageUrl: imageUrls[0], imageUrls } : {}),
    ...price,
    ...(priceNote ? { priceNote } : {}),
    ...(availability ? { availability: availability.split('/').pop()!.slice(0, 100) } : {}),
    specifications,
  };
}
