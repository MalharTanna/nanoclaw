import { describe, expect, it } from 'vitest';

import { crossRoute } from './wa-mode.js';

const platform = () => 'web:waabc123';

describe('crossRoute - WhatsApp switch between Business API and linked device', () => {
  it('linked device: an official-API conversation goes to the person on WhatsApp', () => {
    const r = crossRoute({ channel_type: 'web', platform_id: 'web:waabc123', thread_id: 'waphone_919974035496' }, 'ag', 'linked', platform);
    expect(r).toEqual({ channel_type: 'whatsapp', platform_id: '919974035496@s.whatsapp.net', thread_id: null });
  });

  it('linked device: website visitors stay on the website', () => {
    expect(crossRoute({ channel_type: 'web', platform_id: 'web:k', thread_id: 'visitor-1' }, 'ag', 'linked', platform)).toBeNull();
  });

  it('Business API: a linked-device personal chat goes to the person through the API', () => {
    const r = crossRoute({ channel_type: 'whatsapp', platform_id: '918128284813@s.whatsapp.net', thread_id: null }, 'ag', 'api', platform);
    expect(r).toEqual({ channel_type: 'web', platform_id: 'web:waabc123', thread_id: 'waphone_918128284813' });
  });

  it('Business API: groups cannot be reached, so the send is dropped', () => {
    expect(crossRoute({ channel_type: 'whatsapp', platform_id: '1203630@g.us', thread_id: null }, 'ag', 'api', platform)).toBe('drop');
  });

  it('Business API: a business with no API key yet is left as addressed', () => {
    expect(crossRoute({ channel_type: 'whatsapp', platform_id: '918128284813@s.whatsapp.net', thread_id: null }, 'ag', 'api', () => null)).toBeNull();
  });

  it('no mode set (every other install): nothing changes', () => {
    expect(crossRoute({ channel_type: 'web', platform_id: 'web:k', thread_id: 'waphone_919974035496' }, 'ag', null, platform)).toBeNull();
    expect(crossRoute({ channel_type: 'whatsapp', platform_id: '1203630@g.us', thread_id: null }, 'ag', null, platform)).toBeNull();
  });
});
