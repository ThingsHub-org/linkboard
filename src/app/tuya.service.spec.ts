import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DetailedDiagnosticsSettingsService } from './detailed-diagnostics-settings.service';
import type { TuyaLink } from './link.repository';
import { NativeNfcLaunchService } from './native-nfc-launch.service';
import { TuyaService } from './tuya.service';

describe('TuyaService', () => {
  let service: TuyaService;
  let httpTesting: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.clear();
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
    localStorage.clear();
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

    await expect(execution).resolves.toMatchObject([
      {
        request: {
          method: 'GET',
          url: 'https://openapi.tuyaeu.com/v1.0/token?grant_type=1',
          headers: { client_id: 'client-id' },
        },
        response: { status: 200, body: { success: true, result: { access_token: 'fresh-token' } } },
      },
      {
        request: {
          method: 'POST',
          url: 'https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands',
          headers: { client_id: 'client-id', access_token: 'fresh-token' },
          body: link.tuya.body,
        },
        response: { status: 200, body: { success: true, result: true } },
      },
    ]);
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

  it('includes the sent command when Tuya rejects it', async () => {
    const link = createTuyaLink();
    const execution = service.execute(link, 5000);
    const tokenRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/token?grant_type=1');
    tokenRequest.flush(
      { success: true, result: { access_token: 'fresh-token' } },
      { headers: { 'x-token-trace': 'token-id' } },
    );
    const commandRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands');
    commandRequest.flush(
      { success: false, code: 2009, msg: 'command rejected' },
      { headers: { 'x-command-trace': 'command-id' } },
    );

    await expect(execution).rejects.toMatchObject({
      message: 'Tuya ha rifiutato il comando.',
      command: link.tuya.body,
      diagnostics: [
        {
          request: { method: 'GET', url: 'https://openapi.tuyaeu.com/v1.0/token?grant_type=1' },
          response: {
            status: 200,
            headers: { 'x-token-trace': 'token-id' },
            body: { success: true, result: { access_token: 'fresh-token' } },
          },
        },
        {
          request: {
            method: 'POST',
            url: 'https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands',
            body: link.tuya.body,
          },
          response: {
            status: 200,
            headers: { 'x-command-trace': 'command-id' },
            body: { success: false, code: 2009, msg: 'command rejected' },
          },
        },
      ],
    });
  });

  it('does not retain detailed diagnostics when the setting is disabled', async () => {
    TestBed.inject(DetailedDiagnosticsSettingsService).setEnabled(false);
    const execution = service.execute(createTuyaLink(), 5000);
    const tokenRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/token?grant_type=1');
    tokenRequest.flush({ success: false, code: 1004 });

    await expect(execution).rejects.toMatchObject({
      message: 'Autenticazione Tuya non riuscita.',
      diagnostics: undefined,
    });
  });

  it('captures HTTP error responses and their headers in detailed diagnostics', async () => {
    const execution = service.execute(createTuyaLink(), 5000);
    const tokenRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/token?grant_type=1');
    tokenRequest.flush({ success: true, result: { access_token: 'fresh-token' } });
    const commandRequest = await waitForRequest('https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands');
    commandRequest.flush(
      { code: 4001, msg: 'unsupported command' },
      { status: 400, statusText: 'Bad Request', headers: { 'x-command-trace': 'failed-command-id' } },
    );

    await expect(execution).rejects.toMatchObject({
      message: 'La chiamata Tuya non è riuscita: HTTP 400.',
      diagnostics: [
        {},
        {
          response: {
            status: 400,
            statusText: 'Bad Request',
            headers: { 'x-command-trace': 'failed-command-id' },
            body: { code: 4001, msg: 'unsupported command' },
          },
        },
      ],
    });
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
