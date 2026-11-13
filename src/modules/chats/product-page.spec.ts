import { describe, expect, it } from 'vitest';
import { isCompleteProduct, isUnavailableProduct, parseProductPage } from './product-page.js';
const page = (data: unknown) =>
  `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
describe('product detail evidence', () => {
  it('requires every core detail before a product can be offered', () => {
    const complete = {
      title: 'Headphones',
      description: 'Wireless headphones with a charging case',
      imageUrl: 'https://cdn.example/image.jpg',
      amount: '25000',
      currency: 'NGN',
      availability: 'InStock',
      specifications: { Battery: '30 hours' },
    };
    expect(isCompleteProduct(complete)).toBe(true);
    for (const key of Object.keys(complete)) {
      const missing = { ...complete };
      delete (missing as Record<string, unknown>)[key];
      expect(isCompleteProduct(missing), `missing ${key}`).toBe(false);
    }
    expect(isCompleteProduct({ ...complete, specifications: {} })).toBe(false);
    expect(isCompleteProduct({ ...complete, availability: 'Unknown' })).toBe(false);
    expect(isCompleteProduct({ ...complete, availability: 'OutOfStock' })).toBe(false);
  });
  it('rejects ambiguous decimal commas and accepts properly grouped monetary amounts', () => {
    for (const price of ['349,99', '1.234,56', '25,00', '0', '-10', '1e4']) {
      expect(
        parseProductPage(
          page({ '@type': 'Product', name: 'Item', offers: { price, priceCurrency: 'NGN' } }),
        )?.amount,
      ).toBeUndefined();
    }
    expect(
      parseProductPage(
        page({
          '@type': 'Product',
          name: 'Item',
          offers: { price: '25,000.50', priceCurrency: 'NGN' },
        }),
      ),
    ).toMatchObject({ amount: '25000.50', currency: 'NGN' });
  });
  it('never pairs a price with a currency from a different evidence source', () => {
    const result = parseProductPage(
      page({ '@type': 'Product', name: 'Item', offers: { price: '349.99' } }) +
        '<meta name="product:price:currency" content="NGN">',
    );
    expect(result?.amount).toBeUndefined();
    expect(result?.currency).toBeUndefined();
  });
  it('withholds conflicting prices instead of guessing between metadata and an offer', () => {
    const result = parseProductPage(
      page({ '@type': 'Product', name: 'Item', offers: { price: '30000', priceCurrency: 'NGN' } }) +
        '<meta name="product:price:amount" content="25000"><meta name="product:price:currency" content="NGN">',
    );
    expect(result?.amount).toBeUndefined();
    expect(result?.priceNote).toContain('disagree');
  });
  it('requires option selection when available variants have different prices', () => {
    const result = parseProductPage(
      page({
        '@type': 'Product',
        name: 'Item',
        offers: [
          { price: '100', priceCurrency: 'NGN' },
          { price: '200', priceCurrency: 'NGN' },
        ],
      }),
    );
    expect(result?.amount).toBeUndefined();
    expect(result?.priceNote).toContain('Select product options');
  });
  it('uses the exact selected variant offer when its URL matches', () => {
    const result = parseProductPage(
      page({
        '@type': 'Product',
        name: 'Item',
        url: 'https://shop.example/product/item',
        offers: [
          { url: 'https://shop.example/product/item?size=S', price: '100', priceCurrency: 'NGN' },
          { url: 'https://shop.example/product/item?size=L', price: '200', priceCurrency: 'NGN' },
        ],
      }),
      'https://shop.example/product/item?size=L&utm_source=search',
    );
    expect(result).toMatchObject({ amount: '200', currency: 'NGN' });
  });
  it('does not mistake a related item for the requested product', () => {
    expect(
      parseProductPage(
        page({
          '@type': 'Product',
          name: 'Other item',
          url: 'https://shop.example/product/other',
          offers: { price: '100', priceCurrency: 'NGN' },
        }),
        'https://shop.example/product/requested',
      ),
    ).toBeNull();
  });
  it('cleans encoded markup without leaving script content or inventing a rating scale', () => {
    const result = parseProductPage(
      page({
        '@type': 'Product',
        name: 'Item',
        description: '&lt;p&gt;Real &amp; complete&lt;/p&gt;&lt;script&gt;hidden()&lt;/script&gt;',
        aggregateRating: { ratingValue: 90 },
      }),
    );
    expect(result?.description).toBe('Real & complete');
    expect(result?.specifications.Rating).toBe('90');
  });
  it('recognizes explicit unavailable stock signals without guessing missing stock', () => {
    for (const value of [
      'https://schema.org/OutOfStock',
      'http://schema.org/SoldOut',
      'out of stock',
      'Out_of_stock',
      'Discontinued',
      'BackOrder',
      'PreOrder',
      'Unavailable',
    ])
      expect(isUnavailableProduct(value)).toBe(true);
    for (const value of [
      undefined,
      '',
      'InStock',
      'https://schema.org/LimitedAvailability',
      'Check at checkout',
    ])
      expect(isUnavailableProduct(value)).toBe(false);
  });
  it('selects an available offer when another variant is sold out', () => {
    const result = parseProductPage(
      page({
        '@type': 'Product',
        name: 'Headphones',
        offers: [
          { price: '100', priceCurrency: 'NGN', availability: 'https://schema.org/OutOfStock' },
          { price: '150', priceCurrency: 'NGN', availability: 'https://schema.org/InStock' },
        ],
      }),
    );
    expect(result).toMatchObject({ amount: '150', availability: 'InStock' });
  });
  it('keeps an explicit metadata stock-out over conflicting stale structured data', () => {
    const result = parseProductPage(
      page({
        '@type': 'Product',
        name: 'Headphones',
        offers: { availability: 'https://schema.org/InStock' },
      }) + '<meta property="product:availability" content="out of stock">',
    );
    expect(isUnavailableProduct(result?.availability)).toBe(true);
  });
  it('extracts one item, its offer and specifications from a graph', () => {
    expect(
      parseProductPage(
        page({
          '@graph': [
            {
              '@type': 'Product',
              name: 'Headphones',
              image: ['https://cdn.example/item.jpg'],
              brand: { name: 'Sony' },
              model: 'XM5',
              offers: {
                price: '349.00',
                priceCurrency: 'USD',
                availability: 'https://schema.org/InStock',
              },
              additionalProperty: [{ name: 'Battery', value: '30 hours' }],
            },
          ],
        }),
      ),
    ).toMatchObject({
      title: 'Headphones',
      amount: '349.00',
      currency: 'USD',
      availability: 'InStock',
      imageUrl: 'https://cdn.example/item.jpg',
      specifications: { brand: 'Sony', model: 'XM5', Battery: '30 hours' },
    });
  });
  it('keeps image galleries, full descriptions and referenced merchant details', () => {
    const description = '<p>' + 'Full product information. '.repeat(80) + '</p>';
    const result = parseProductPage(
      page({
        '@graph': [
          {
            '@type': 'Product',
            '@id': 'https://shop.example/product/one#product',
            name: 'Headphones &amp; Case',
            description,
            sku: 123,
            image: ['/one.jpg', { url: 'https://cdn.example/two.jpg' }],
            brand: { '@id': '#brand' },
            offers: {
              price: 70000,
              priceCurrency: 'NGN',
              seller: { '@id': '#seller' },
              hasMerchantReturnPolicy: { merchantReturnDays: 7 },
              shippingDetails: {
                deliveryTime: { transitTime: { minValue: 1, maxValue: 5, unitCode: 'DAY' } },
              },
            },
            aggregateRating: { ratingValue: 4.5, reviewCount: 42 },
            additionalProperty: [{ name: 'Battery', value: 50 }],
          },
          { '@type': 'Brand', '@id': '#brand', name: 'Sony' },
          { '@type': 'Organization', '@id': '#seller', name: 'Merchant' },
        ],
      }),
      'https://shop.example/product/one',
    );
    expect(result).toMatchObject({
      title: 'Headphones & Case',
      amount: '70000',
      imageUrls: ['https://shop.example/one.jpg', 'https://cdn.example/two.jpg'],
      specifications: {
        sku: '123',
        brand: 'Sony',
        Seller: 'Merchant',
        Battery: '50',
        Rating: '4.5',
        Reviews: '42',
        'Return period': '7 days',
        'Estimated shipping transit': '1–5 days',
      },
    });
    expect(result!.description.length).toBeGreaterThan(1000);
    expect(result!.description).not.toContain('<p>');
  });
  it('uses product Open Graph metadata when structured data is absent', () => {
    const result = parseProductPage(
      `<meta property="og:type" content="product"><meta content="Headphones &amp; Case" property="og:title"><meta property="og:image" content="https://cdn.example/image.jpg"><meta name="product:price:amount" content="25,000.00"><meta name="product:price:currency" content="NGN">`,
    );
    expect(result).toMatchObject({
      title: 'Headphones & Case',
      imageUrl: 'https://cdn.example/image.jpg',
      amount: '25000.00',
      currency: 'NGN',
    });
    expect(
      parseProductPage(
        '<meta property="og:title" content="Category"><meta property="og:image" content="https://cdn.example/category.jpg">',
      ),
    ).toBeNull();
  });
  it('excludes category listings, malformed metadata and ambiguous products', () => {
    expect(
      parseProductPage(
        page({ '@type': 'ItemList', itemListElement: [{ '@type': 'Product', name: 'One' }] }),
      ),
    ).toBeNull();
    expect(
      parseProductPage(
        page([
          { '@type': 'Product', name: 'One' },
          { '@type': 'Product', name: 'Two' },
        ]),
      ),
    ).toBeNull();
    expect(parseProductPage('<script type="application/ld+json">bad</script>')).toBeNull();
  });
  it('does not invent missing offers or accept unsafe images and invalid prices', () => {
    expect(
      parseProductPage(
        page({
          '@type': 'Product',
          name: 'One',
          image: 'javascript:alert(1)',
          offers: { price: 'free', priceCurrency: 'NGN' },
        }),
      ),
    ).toEqual({ title: 'One', description: '', specifications: {} });
  });
});
