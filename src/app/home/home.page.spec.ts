import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { ComponentFixture } from '@angular/core/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { vi } from 'vitest';

import { DetailedDiagnosticsSettingsService } from '../detailed-diagnostics-settings.service';
import { LinkNfcService } from '../link-nfc.service';
import { LinkStore } from '../link.store';
import { NativePlatformService } from '../native-platform.service';
import { TuyaRequestError, TuyaService } from '../tuya.service';

import { HomePage } from './home.page';

describe('HomePage', () => {
  let component: HomePage;
  let fixture: ComponentFixture<HomePage>;
  let httpTesting: HttpTestingController;
  let originalClipboard: PropertyDescriptor | undefined;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    localStorage.clear();
    originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    await TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    }).compileComponents();
    TestBed.inject(DetailedDiagnosticsSettingsService).setEnabled(true);
    const nfc = TestBed.inject(LinkNfcService);
    vi.spyOn(nfc, 'isSupported', 'get').mockReturnValue(true);
    vi.spyOn(nfc, 'startScanning').mockResolvedValue(vi.fn());
    fixture = TestBed.createComponent(HomePage);
    component = fixture.componentInstance;
    httpTesting = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
    await vi.waitFor(() => expect(TestBed.inject(LinkStore).isReady()).toBe(true));
  });

  afterEach(() => {
    httpTesting.verify();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
    TestBed.resetTestingModule();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('starts NFC scanning when the home page opens', async () => {
    const nfc = TestBed.inject(LinkNfcService);

    await vi.waitFor(() => expect(nfc.startScanning).toHaveBeenCalledOnce());
    expect(component.isScanningNfc()).toBe(true);
  });

  it('filters links by name and hostname', () => {
    TestBed.inject(LinkStore).save('Documentazione', 'https://example.com');
    component.searchTerm = 'example';

    expect(component.filteredLinks).toHaveLength(1);
    component.searchTerm = 'nessun risultato';
    expect(component.filteredLinks).toHaveLength(0);
  });

  it('orders links from the home page and disables moves at the ends', () => {
    const linkStore = TestBed.inject(LinkStore);
    linkStore.replaceAll([
      { id: 'first', name: 'First', url: 'https://first.example' },
      { id: 'second', name: 'Second', url: 'https://second.example' },
      { id: 'third', name: 'Third', url: 'https://third.example' },
    ]);
    fixture.detectChanges();

    const firstCard = fixture.nativeElement.querySelector('.launcher-card');
    expect(firstCard.querySelector('.link-host')).toBeNull();
    expect(firstCard.querySelector('.method-tag')).toBeNull();
    expect(fixture.nativeElement.querySelector('[aria-label="Sposta First prima"]').disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('[aria-label="Sposta Third dopo"]').disabled).toBe(true);
    fixture.nativeElement.querySelector('[aria-label="Sposta Third prima"]').click();
    fixture.detectChanges();

    expect(linkStore.links().map((link) => link.id)).toEqual(['first', 'third', 'second']);
  });

  it('persists an image with its configured link', async () => {
    const imageDataUrl = 'data:image/jpeg;base64,cGhvdG8=';
    const linkStore = TestBed.inject(LinkStore);

    linkStore.save('API', 'https://api.example.com/status', undefined, imageDataUrl);
    TestBed.flushEffects();
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem('linkboard.links') ?? '[]')[0].imageDataUrl).toBe(imageDataUrl),
    );

    expect(linkStore.links()[0].imageDataUrl).toBe(imageDataUrl);
  });

  it('sends a GET request and marks a 2xx response as successful', async () => {
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    const request = component.callLink(link);
    const httpRequest = httpTesting.expectOne(link.url);

    expect(httpRequest.request.method).toBe('GET');
    httpRequest.flush('ok', { status: 200, statusText: 'OK' });
    await request;

    expect(component.requestState(link.id)?.status).toBe('success');
  });

  it('shows and copies detailed diagnostics for a normal GET request', async () => {
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    TestBed.inject(LinkStore).replaceAll([link]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fixture.detectChanges();
    const request = component.callLink(link);
    httpTesting.expectOne(link.url).flush('service response', {
      status: 200,
      statusText: 'OK',
      headers: { 'x-trace-id': 'normal-get-id' },
    });
    await request;
    fixture.detectChanges();

    const diagnostics = fixture.nativeElement.querySelector('.request-diagnostics pre').textContent;
    const exchange = JSON.parse(diagnostics).exchanges[0];
    expect(exchange.request).toMatchObject({
      method: 'GET',
      url: link.url,
      headers: {},
    });
    expect(exchange.response).toMatchObject({
      status: 200,
      headers: { 'x-trace-id': 'normal-get-id' },
      body: 'service response',
    });

    fixture.nativeElement.querySelector('.request-diagnostics button').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(diagnostics));

    fixture.nativeElement.querySelector('[aria-label="Chiudi diagnostica dettagliata"]').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.request-diagnostics')).toBeNull();
    expect(component.requestState(link.id)).toMatchObject({ status: 'success', diagnostics: undefined });
  });

  it('shows Android HTTP response headers and body in detailed diagnostics', async () => {
    const link = { id: 'native', name: 'Native', url: 'https://api.example.com/status' };
    TestBed.inject(LinkStore).replaceAll([link]);
    const nativeNfc = TestBed.inject(NativePlatformService);
    vi.spyOn(nativeNfc, 'isAndroidApp', 'get').mockReturnValue(true);
    vi.spyOn(nativeNfc, 'httpGet').mockResolvedValue({
      status: 200,
      data: 'android response',
      headers: { 'x-trace-id': 'android-get-id' },
      url: link.url,
    });
    fixture.detectChanges();

    await component.callLink(link);
    fixture.detectChanges();

    const exchange = JSON.parse(fixture.nativeElement.querySelector('.request-diagnostics pre').textContent)
      .exchanges[0];
    expect(exchange.response).toMatchObject({
      status: 200,
      url: link.url,
      headers: { 'x-trace-id': 'android-get-id' },
      body: 'android response',
    });
  });

  it('routes Tuya links through the Tuya service and avoids claiming physical state', async () => {
    const link = {
      id: 'tuya-link',
      name: 'Lampada',
      url: 'https://openapi.tuyaeu.com',
      type: 'tuya' as const,
      tuya: {
        region: 'eu' as const,
        deviceId: 'device-123',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        body: '{"commands":[]}',
      },
    };
    const execute = vi.spyOn(TestBed.inject(TuyaService), 'execute').mockResolvedValue(undefined);

    await component.callLink(link);

    expect(execute).toHaveBeenCalledWith(link, 15000);
    expect(component.requestState(link.id)).toMatchObject({
      status: 'success',
      message: expect.stringContaining('stato fisico del dispositivo non è verificato'),
    });
  });

  it('shows and copies full Tuya diagnostics when Tuya rejects a command', async () => {
    const command = '{"commands":[{"code":"switch_1","value":true}]}';
    const link = {
      id: 'tuya-link',
      name: 'Lampada',
      url: 'https://openapi.tuyaeu.com',
      type: 'tuya' as const,
      tuya: {
        region: 'eu' as const,
        deviceId: 'device-123',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        body: command,
      },
    };
    TestBed.inject(LinkStore).replaceAll([link]);
    vi.spyOn(TestBed.inject(TuyaService), 'execute').mockRejectedValue(
      new TuyaRequestError('Tuya ha rifiutato il comando.', undefined, command, [
        {
          request: {
            method: 'POST',
            url: 'https://openapi.tuyaeu.com/v1.0/iot-03/devices/device-123/commands',
            headers: { client_id: 'client-id', sign: 'signature', access_token: 'token' },
            body: command,
          },
          response: {
            status: 200,
            headers: { 'x-trace-id': 'trace-123' },
            body: { success: false, code: 2009, msg: 'command rejected' },
          },
        },
      ]),
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    fixture.detectChanges();

    await component.callLink(link);
    fixture.detectChanges();

    const diagnostics = fixture.nativeElement.querySelector('.request-diagnostics pre').textContent;
    expect(JSON.parse(diagnostics).exchanges[0].request.body).toBe(command);
    expect(diagnostics).toContain('access_token');
    expect(diagnostics).toContain('trace-123');
    expect(diagnostics).toContain('command rejected');
    fixture.nativeElement.querySelector('.request-diagnostics button').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(diagnostics));
    await vi.waitFor(() => expect(component.requestState(link.id)?.copyMessage).toContain('Diagnostica copiata'));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.request-diagnostics [role="status"]').textContent).toContain(
      'copiata',
    );
  });

  it('highlights a tapped link yellow while its request is in progress', async () => {
    const linkStore = TestBed.inject(LinkStore);
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    linkStore.replaceAll([link]);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.launcher-button').click();
    fixture.detectChanges();

    expect(component.requestState(link.id)?.status).toBe('loading');
    expect(fixture.nativeElement.querySelector('.launcher-card.is-loading')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('.launcher-button.is-loading')).not.toBeNull();

    httpTesting.expectOne(link.url).flush('ok', { status: 200, statusText: 'OK' });
    await vi.waitFor(() => expect(component.requestState(link.id)?.status).toBe('success'));
  });

  it('highlights a link green when its NFC-triggered request succeeds', async () => {
    const linkStore = TestBed.inject(LinkStore);
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    linkStore.replaceAll([link]);
    fixture.detectChanges();

    const nfc = TestBed.inject(LinkNfcService);
    const onLinkRead = vi.mocked(nfc.startScanning).mock.calls[0][0];
    onLinkRead(link.id);
    fixture.detectChanges();

    expect(component.requestState(link.id)?.status).toBe('loading');
    expect(fixture.nativeElement.querySelector('.launcher-card.is-loading')).not.toBeNull();

    httpTesting.expectOne(link.url).flush('ok', { status: 200, statusText: 'OK' });

    await vi.waitFor(() => expect(component.requestState(link.id)?.status).toBe('success'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.launcher-card.is-success')).not.toBeNull();
  });

  it('highlights a link red when its NFC-triggered request fails', async () => {
    const linkStore = TestBed.inject(LinkStore);
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    linkStore.replaceAll([link]);
    fixture.detectChanges();

    const nfc = TestBed.inject(LinkNfcService);
    const onLinkRead = vi.mocked(nfc.startScanning).mock.calls[0][0];
    onLinkRead(link.id);
    httpTesting.expectOne(link.url).flush('unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });

    await vi.waitFor(() => expect(component.requestState(link.id)?.status).toBe('error'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.launcher-card.is-error')).not.toBeNull();
  });

  it('prompts for another NFC scan after showing the request result', async () => {
    vi.useFakeTimers();
    const linkStore = TestBed.inject(LinkStore);
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    linkStore.replaceAll([link]);
    fixture.detectChanges();

    const nfc = TestBed.inject(LinkNfcService);
    const onLinkRead = vi.mocked(nfc.startScanning).mock.calls[0][0];
    onLinkRead(link.id);
    httpTesting.expectOne(link.url).flush('ok', { status: 200, statusText: 'OK' });

    await vi.waitFor(() => expect(component.nfcMessage()).toContain('chiamata riuscita'));
    await vi.advanceTimersByTimeAsync(5000);
    fixture.detectChanges();
    expect(component.nfcMessage()).toBe('Avvicina un altro tag NFC associato per una nuova scansione.');
    expect(fixture.nativeElement.querySelector('.nfc-status').textContent).toContain('Avvicina un altro tag');

    onLinkRead(link.id);
    httpTesting.expectOne(link.url).flush('unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });

    await vi.waitFor(() => expect(component.nfcMessage()).toContain('HTTP 503'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(component.nfcMessage()).toBe('Avvicina un altro tag NFC associato per una nuova scansione.');
  });

  it('clears successful and failed link highlights after five seconds', async () => {
    vi.useFakeTimers();
    TestBed.inject(DetailedDiagnosticsSettingsService).setEnabled(false);
    const linkStore = TestBed.inject(LinkStore);
    const successLink = { id: 'success', name: 'Success', url: 'https://success.example' };
    const errorLink = { id: 'error', name: 'Error', url: 'https://error.example' };
    linkStore.replaceAll([successLink, errorLink]);
    fixture.detectChanges();

    const successRequest = component.callLink(successLink);
    httpTesting.expectOne(successLink.url).flush('ok', { status: 200, statusText: 'OK' });
    await successRequest;
    expect(component.requestState(successLink.id)?.status).toBe('success');

    await vi.advanceTimersByTimeAsync(2500);
    const errorRequest = component.callLink(errorLink);
    httpTesting.expectOne(errorLink.url).flush('unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    await errorRequest;

    await vi.advanceTimersByTimeAsync(2500);
    expect(component.requestState(successLink.id)).toBeUndefined();
    expect(component.requestState(errorLink.id)?.status).toBe('error');

    await vi.advanceTimersByTimeAsync(2500);
    expect(component.requestState(errorLink.id)).toBeUndefined();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.launcher-card.is-success, .launcher-card.is-error')).toBeNull();
  });

  it('scrolls a highlighted link into view when it is outside the viewport', async () => {
    const linkStore = TestBed.inject(LinkStore);
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    linkStore.replaceAll([link]);
    fixture.detectChanges();

    const card = fixture.nativeElement.querySelector('.launcher-card') as HTMLElement;
    vi.spyOn(card, 'getBoundingClientRect').mockReturnValue({
      top: window.innerHeight + 20,
      bottom: window.innerHeight + 200,
      left: 0,
      right: 200,
      width: 200,
      height: 180,
      x: 0,
      y: window.innerHeight + 20,
      toJSON: () => ({}),
    });
    const scrollIntoView = vi.fn();
    Object.defineProperty(card, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    const request = component.callLink(link);
    httpTesting.expectOne(link.url).flush('ok', { status: 200, statusText: 'OK' });
    await request;
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'nearest' });
  });

  it('sends private HTTP links without CORS and reports the hidden response as unverified', async () => {
    const link = { id: 'shelly', name: 'Shelly', url: 'http://192.168.10.171/rpc/Switch.Toggle?id=0' };
    const opaqueResponse = new Response();
    Object.defineProperty(opaqueResponse, 'type', { value: 'opaque' });
    const fetchMock = vi.fn().mockResolvedValue(opaqueResponse);
    vi.stubGlobal('fetch', fetchMock);

    await component.callLink(link);

    expect(fetchMock).toHaveBeenCalledWith(link.url, expect.objectContaining({ method: 'GET', mode: 'no-cors' }));
    expect(component.requestState(link.id)?.status).toBe('unverified');
    expect(component.requestState(link.id)?.message).toContain('codice HTTP non è leggibile');
    const diagnostics = JSON.parse(component.requestState(link.id)?.diagnostics ?? '{}');
    expect(diagnostics.exchanges[0]).toMatchObject({
      request: { method: 'GET', mode: 'no-cors' },
      response: { status: 0, type: 'opaque', body: null },
    });
  });

  it('marks a non-2xx response as an error', async () => {
    const link = { id: 'api', name: 'API', url: 'https://api.example.com/status' };
    const request = component.callLink(link);

    httpTesting.expectOne(link.url).flush('unavailable', {
      status: 503,
      statusText: 'Service Unavailable',
    });
    await request;

    expect(component.requestState(link.id)?.status).toBe('error');
    expect(component.requestState(link.id)?.message).toContain('503');
    expect(JSON.parse(component.requestState(link.id)?.diagnostics ?? '{}').exchanges[0].response).toMatchObject({
      status: 503,
      body: 'unavailable',
    });
  });

  it('marks a request without a response as a timeout and cancels it', async () => {
    const linkStore = TestBed.inject(LinkStore);
    linkStore.save('API', 'https://api.example.com/status');
    const link = linkStore.links()[0];
    fixture.detectChanges();
    const request = component.callLink(link, 25);
    const httpRequest = httpTesting.expectOne(link.url);

    await request;
    fixture.detectChanges();

    expect(httpRequest.cancelled).toBe(true);
    expect(component.requestState(link.id)?.status).toBe('error');
    expect(component.requestState(link.id)?.message).toContain('Timeout');
    expect(fixture.nativeElement.querySelector('.feedback-error')).not.toBeNull();
  });
});
