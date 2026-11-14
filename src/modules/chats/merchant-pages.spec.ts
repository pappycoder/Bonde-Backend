import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isCompleteProduct, isUnavailableProduct, parseProductPage } from './product-page.js';

const merchantSamples = [
  {
    name: 'slot',
    url: 'https://slot.ng/products/pre-owned-apple-iphone-13-pro-256gb',
    amount: '612200',
  },
  {
    name: 'pointek',
    url: 'https://www.pointekonline.com/product/apple-airpods-pro-3/',
    amount: '400000.00',
  },
  { name: 'kara', url: 'https://kara.com.ng/hp-laptop-ai-15-fd2050wm', amount: '874500' },
];

for (const merchant of merchantSamples) {
  const html = readFileSync(
    new URL(`./fixtures/merchants/${merchant.name}.html`, import.meta.url),
    'utf8',
  );
  describe(`${merchant.name} captured product metadata`, () => {
    it('extracts a complete item with its exact price, stock, images and specifications', () => {
      const item = parseProductPage(html, merchant.url);
      expect(isCompleteProduct(item)).toBe(true);
      expect(item).toMatchObject({
        amount: merchant.amount,
        currency: 'NGN',
        availability: 'InStock',
      });
      expect(item!.imageUrl).toMatch(/^https:\/\//);
      expect(Object.keys(item!.specifications).length).toBeGreaterThan(0);
    });
    it('excludes the item when the merchant marks it out of stock', () => {
      const unavailable = html
        .replaceAll('InStock', 'OutOfStock')
        .replaceAll('in stock', 'out of stock');
      const item = parseProductPage(unavailable, merchant.url);
      expect(isUnavailableProduct(item?.availability)).toBe(true);
      expect(isCompleteProduct(item)).toBe(false);
    });
    it('does not accept an item whose price is missing', () => {
      const missingPrice = html.replace(/"price"\s*:\s*(?:"[^"]*"|[\d.]+)/g, '"price":null');
      expect(isCompleteProduct(parseProductPage(missingPrice, merchant.url))).toBe(false);
    });
  });
}

it('uses Pointek’s current sale offer rather than its higher list price', () => {
  const html = readFileSync(new URL('./fixtures/merchants/pointek.html', import.meta.url), 'utf8');
  expect(html).toContain('430000.00');
  expect(parseProductPage(html, merchantSamples[1].url)?.amount).toBe('400000.00');
});

it('cleans Pointek catalog entities without exposing HTML escapes in the details', () => {
  const html = readFileSync(new URL('./fixtures/merchants/pointek.html', import.meta.url), 'utf8');
  const item = parseProductPage(html, merchantSamples[1].url)!;
  expect(item.description).not.toContain('&nbsp;');
  expect(item.description).not.toContain('&amp;');
  expect(item.specifications.Seller).toContain('Gadgets & Computers');
});
