# Roadmap: link cloud Tuya

## Obiettivo

Estendere Linkboard per supportare link che inviano comandi a dispositivi Tuya, mantenendo il comportamento già presente nella home: un click o la lettura di un tag NFC avvia l'azione associata al link. La home deve instradare l'azione in base al tipo configurato, senza richiedere un'interazione o un pulsante Tuya separati.

Il supporto Tuya è il primo caso di link cloud. La struttura dovrà consentire di aggiungere in seguito altri provider cloud, senza modificare il flusso di attivazione dalla home.

## Decisioni e vincoli

- Al momento non è previsto un backend. Linkboard è un'app a uso fortemente personale e la distribuzione è manuale e controllata.
- La documentazione Tuya prevede, per l'accesso semplice ai dati del progetto cloud, una richiesta iniziale `GET /v1.0/token?grant_type=1` firmata con `client_id` e `secret`. La risposta include `access_token`, `refresh_token` e `expire_time`; il token è necessario per le successive API business.
- La firma non è la stessa per tutte le richieste: le API di gestione token e le API business hanno regole distinte; le richieste business includono anche l'access token nella stringa firmata. L'integrazione dovrà seguire la documentazione Tuya applicabile al progetto e alla relativa API.
- La richiesta iniziale di autenticazione e quelle business sono entrambe chiamate al servizio remoto e possono incontrare limiti CORS nella PWA. Inoltre, senza backend il segreto usato per firmare le richieste deve essere disponibile al client: la distribuzione controllata riduce l'esposizione, ma non rende il segreto irrecuperabile da chi può accedere all'app o al dispositivo.
- La stessa funzionalità dovrà essere utilizzabile nella PWA e nell'app nativa Android. La PWA può incontrare limitazioni CORS imposte dal servizio remoto; il percorso nativo può usare il trasporto disponibile su Android. Le due modalità vanno verificate separatamente, senza introdurre un backend come requisito iniziale.
- È prevista in seguito la versione iOS; le scelte di integrazione non dovranno precluderla, ma il supporto iOS non è parte della prima implementazione.
- Il body della richiesta POST è configurabile come testo libero; per il caso Tuya il contenuto sarà JSON. La gestione dovrà preservare il testo configurato e segnalare chiaramente un JSON non valido quando il tipo di link richiede JSON.
- La pagina Settings deve permettere di scegliere il tipo di link: link normale (comportamento esistente), Tuya e, in futuro, altri provider cloud. Le impostazioni specifiche vanno mostrate in funzione del tipo scelto.
- Sono già disponibili per Tuya la regione/data center, l'identificativo del dispositivo e i segreti richiesti. La roadmap non deve bloccare l'avvio chiedendo nuovamente questi dati.
- I segreti possono essere mantenuti persistenti nel file di backup. Backup ed esportazioni che li contengono vanno trattati come dati sensibili e non condivisi; l'utente deve poter sapere che il backup li include.
- L'integrazione non deve alterare il comportamento dei link normali né la modalità di attivazione da click o NFC.

## Fasi proposte

### 1. Definire il modello dei link

- Rappresentare in modo persistente il tipo di link e i dati necessari all'azione.
- Mantenere invariati i dati e l'esecuzione dei link normali esistenti.
- Per le richieste cloud, rendere configurabili il body POST come testo libero e, per Tuya, i campi JSON necessari al comando.
- Assicurare che backup e ripristino conservino il tipo di link, la configurazione e i segreti Tuya, chiarendo che il backup contiene credenziali sensibili.

### 2. Aggiornare Settings

- Aggiungere la scelta del tipo di link: normale o Tuya, predisponendo l'estensione a futuri provider.
- Mostrare i campi specifici Tuya, inclusi regione/data center, identificativo del dispositivo e segreti già disponibili nell'app.
- Consentire la configurazione del body POST come testo libero e validare il formato JSON richiesto per Tuya prima del salvataggio o dell'invio.
- Evitare di esporre i segreti in chiaro più del necessario e non includerli nei log o nei messaggi di errore.

### 3. Instradare l'attivazione dalla home

- Conservare l'interazione esistente: click sul link o lettura NFC avvia l'azione associata.
- Se il link è normale, eseguire la chiamata e mantenere il comportamento attuale.
- Se il link è Tuya, ottenere un access token con `GET /v1.0/token?grant_type=1` oppure riutilizzare quello già valido, secondo la strategia scelta.
- Prima dell'implementazione, verificare se sia preferibile richiedere un token nuovo a ogni attivazione o conservarlo fino alla scadenza e rinnovarlo; la documentazione restituisce `expire_time` e `refresh_token`, ma non prescrive esplicitamente quale strategia adottare per questo caso.
- Gestire in modo esplicito autenticazione fallita, token scaduto e rinnovo non riuscito, se si sceglie di riutilizzare e rinnovare il token.
- Dopo l'autenticazione, inviare la richiesta cloud configurata usando il body JSON e i dati Tuya salvati, con la firma business che include l'access token.
- Separare l'instradamento dalla logica specifica del provider, così da poter aggiungere altri cloud senza cambiare l'interazione della home.
- Comunicare gli esiti e gli errori senza mostrare segreti e senza dichiarare un cambio di stato fisico quando il servizio conferma soltanto la ricezione del comando.

#### Pseudocodice prima della chiamata Tuya

Il body va validato principalmente in Settings, prima del salvataggio; il controllo mostrato qui è una salvaguardia prima dell'invio, ad esempio per configurazioni importate o alterate. La scelta tra richiedere un token per ogni attivazione e riutilizzarlo fino alla scadenza è ancora da verificare. Il flusso è una traccia progettuale e non è ancora implementato. I dettagli di firma e rinnovo vanno verificati sulla documentazione Tuya applicabile.

```text
quando l'utente attiva un link:
    se il tipo di link è normale:
        esegui il flusso esistente
        termina

    leggi la configurazione Tuya del link
    se la configurazione richiesta è incompleta:
        segnala un errore senza mostrare i segreti
        termina

    verifica che il body caricato sia JSON valido come controllo difensivo
    se non è valido (ad esempio per dati importati o alterati):
        segnala l'errore di configurazione senza inviare la richiesta
        termina

    se si è scelto di riutilizzare il token:
        leggi il token e la sua scadenza salvati
        se il token non è valido o è prossimo alla scadenza:
            ottieni o rinnova il token secondo il flusso Tuya documentato
    altrimenti:
        ottieni un token con GET /v1.0/token?grant_type=1

    se non è disponibile un token valido:
        segnala l'errore di autenticazione senza mostrare i segreti
        termina
    se si è scelto di riutilizzare il token:
        salva il token e la scadenza secondo la persistenza prevista

    prepara la richiesta business con endpoint, body e credenziali Tuya
    calcola la firma business includendo l'access token,
        seguendo la documentazione Tuya
    invia la richiesta
    gestisci esplicitamente errori di rete, timeout e risposta Tuya non valida
    comunica l'esito senza affermare che lo stato fisico sia cambiato
```

### 4. Verificare piattaforme e backup

- Verificare la richiesta Tuya nella PWA e documentare/gestire gli eventuali errori CORS del servizio remoto, senza assumere che la PWA possa aggirarli.
- Verificare separatamente il trasporto e l'invio del comando nell'app nativa Android.
- Verificare che backup e ripristino preservino configurazione e segreti e che l'utente sia informato della loro presenza nel file.
- Verificare il flusso di autenticazione scelto: acquisizione con GET a ogni attivazione oppure riuso e rinnovo del token, firma delle chiamate business ed errori di autenticazione.
- Mantenere le scelte compatibili con una futura implementazione iOS, rimandandone test e rilascio a una fase successiva.

## Criteri di completamento

- Settings consente di scegliere tra link normale e Tuya e mostra la configurazione relativa al tipo selezionato.
- La home continua ad attivare il link con click o NFC e instrada la chiamata corretta per ciascun tipo.
- I link normali mantengono il comportamento preesistente.
- Il body POST è configurabile come testo libero e il body Tuya JSON viene validato prima dell'invio.
- La chiamata Tuya usa la strategia di token scelta dopo aver verificato acquisizione, eventuale riuso/rinnovo e limiti del servizio, e applica una firma corretta sia per l'autenticazione sia per la richiesta business.
- La configurazione Tuya, compresi i segreti, viene preservata nel backup con un'indicazione chiara del carattere sensibile del file.
- PWA e Android sono verificati distintamente, compresa la strategia scelta per la richiesta GET di autenticazione; eventuali limitazioni CORS nella PWA sono comunicate senza introdurre un backend obbligatorio.
- Errori di autenticazione, rete, timeout e risposte non valide sono comunicati senza un falso esito positivo o la divulgazione di credenziali.

## Fuori ambito iniziale

- Backend o proxy cloud: non richiesti per la distribuzione personale e controllata attuale.
- Versione iOS: prevista in seguito.
- Scoperta e associazione automatica dei dispositivi Tuya.
- Sincronizzazione di dispositivi o credenziali tra installazioni.
- Esecuzione di richieste arbitrarie al di fuori della configurazione del link.
- Garanzia di conferma dello stato fisico senza un'esplicita verifica dello stato del dispositivo.

## Punto di validazione

Questa roadmap non implementa ancora le modifiche. Prima di procedere, verificare come integrare il tipo di link e la configurazione nel modello e nel backup esistenti, confermare che il progetto Tuya usa la modalità semplice (`grant_type=1`) e verificare la fattibilità del flusso di autenticazione e della chiamata business sia dalla PWA (con i limiti CORS del servizio) sia da Android. La distribuzione controllata e la persistenza dei segreti nel backup sono assunzioni esplicite del perimetro iniziale, ma non eliminano il rischio di estrazione del segreto dal client.

## Riferimenti Tuya

- [Authentication Method](https://developer.tuya.com/en/docs/iot/authentication-method?id=Ka49gbaxjygox): modalità semplice e OAuth 2.0, richiesta GET per ottenere il token e requisiti.
- [Get Token](https://developer.tuya.com/en/docs/cloud/6c1636a9bd?id=Ka7kjumkoa53v): endpoint, `grant_type`, campi della risposta e durata del token.
- [Sign Requests for Cloud Authorization](https://developer.tuya.com/en/docs/iot/new-singnature?id=Kbw0q34cs2e5g): firma HMAC-SHA256 e differenze tra gestione token e API business.
