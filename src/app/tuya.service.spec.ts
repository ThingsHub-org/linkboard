import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TuyaLink } from './link.repository';
import { NativeNfcLaunchService } from './native-nfc-launch.service';
import { TuyaService } from './tuya.service';

describe('TuyaService', () => {
  let service: TuyaService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(TuyaService);
    httpTesting = TestBed.inject(HttpTestingController);
    vi.spyOn(TestBed.inject(NativeNfcLaunchService), 'isAndroidApp', 'get').mockReturnValue(false);
    vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
    vi.stubGlobal('crypto', webcrypto);
  });

  afterEach(() => {
    httpTesting.verify();
    vi.restoreAllMocks();
    TestBed.resetTestingModule();
  });

  it('gets a token and sends a correctly signed Tuya command', async () => {
    const link = createTuyaLink();
    const execution = service.execute(link, 5000);
    const tokenRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/token?grant_type=1');

    expect(tokenRequest.request.method).toBe('GET');
    expect(tokenRequest.request.headers.get('client_id')).toBe('client-id');
    expect(tokenRequest.request.headers.get('sign')).toBe(
      '4ADC484D15B73137A7740F01BEFB5604C3F7BFC341694E878B2ED04617E08394',
    );
    tokenRequest.flush({ success: true, result: { access_token: 'fresh-token' } });

    const commandRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands');

    expect(commandRequest.request.method).toBe('POST');
    expect(commandRequest.request.body).toBe(link.tuya.body);
    expect(commandRequest.request.headers.get('access_token')).toBe('fresh-token');
    expect(commandRequest.request.headers.get('sign')).toBe(
      'B330C40F61E59EBA8AECAFC2136CDE0E9E95875E60130585BFFD9665BB866785',
    );
    commandRequest.flush({ success: true, result: true });

    await expect(execution).resolves.toBeUndefined();
  });

  it('does not send a command when Tuya authentication fails', async () => {
    const execution = service.execute(createTuyaLink(), 5000);
    const tokenRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/token?grant_type=1');
    tokenRequest.flush({
      success: false,
      code: 1004,
      msg: 'authentication failed',
    });

    await expect(execution).rejects.toThrow('Autenticazione Tuya non riuscita');
    expect(httpTesting.match('https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands')).toHaveLength(0);
  });

  async function waitForRequest(url: string): Promise<ReturnType<HttpTestingController['expectOne']>> {
    let request: ReturnType<HttpTestingController['expectOne']> | undefined;
    await vi.waitFor(() => {
      const matches = httpTesting.match(url);
      if (matches.length > 0) request = matches[0];
      expect(request).toBeDefined();
    });
    return request!;
  }
});

function createTuyaLink(): TuyaLink {
  return {
    id: 'tuya-link',
    name: 'Lampada',
    url: 'https://openapi.tuyaeu.com',
    type: 'tuya',
    tuya: {
      region: 'eu',
      deviceId: 'device-123',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      body: '{ "commands": [{"code":"switch_1","value":true}] }',
    },
  };
}
