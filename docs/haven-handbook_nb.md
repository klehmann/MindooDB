# Haven-håndboken

En komplett og lettlest guide til MindooDB Haven — det nettleserbaserte arbeidsområdet for kryptert, lokal-først samarbeid på MindooDB.

Håndboken går gjennom alt Haven gjør, i den rekkefølgen du sannsynligvis møter det. Den er skrevet for tre overlappende lesergrupper: vanlige brukere som tilbringer tiden sin i Arbeidsområdet, teamadministratorer som setter opp tenanter og registrerer apper, og plattformadministratorer som drifter en MindooDB-server. Du trenger ikke lese den fra perm til perm. Kan du grunnlaget allerede, lar overskriftene deg hoppe rett til det du trenger. Er du helt fersk, start på begynnelsen og følg gjennomgangen av de første ti minuttene.

## Hva Haven er, og hvorfor det finnes

Haven er den visuelle inngangsdøren til MindooDB. MindooDB alene er en databasemotor: den lagrer krypterte dokumenter på en server et sted, synkroniserer dem mellom enheter og fører en kryptografisk signert historikk over hver eneste endring. Haven er det grafiske arbeidsområdet du faktisk ser på. Det kjører helt og holdent i en nettleser, samler alt du trenger for å bruke MindooDB til daglig, og holder dataene dine på din egen enhet når det er mulig.

Noen få ting skiller Haven fra en vanlig webapp.

Haven er lokal-først. Nesten alt du ser, serveres fra en kopi — en lokal replika — som ligger i denne nettleseren. Å bla, redigere, søke og til og med bygge virtuelle visninger skjer mot den lokale replikaen, så Haven er raskt og fortsetter å virke når nettet er borte. Serveren kontaktes bare når du synkroniserer, og dataene på linja er alltid ende-til-ende-kryptert.

Haven er en progressiv webapp. Den kan installeres på telefoner og nettbrett, inkludert iPhone, iPad og Android, og startes rett fra Hjem-skjermen som en vanlig app. Når den er installert, åpnes den i frittstående modus uten nettleserramme, noe som gir deg mer skjermplass og en roligere følelse. På iPhone kan du til og med legge Haven til på Hjem-skjermen mer enn én gang — hver installerte kopi får sitt eget private lager, og det er en ryddig måte å holde private data, jobbdata og demodata helt adskilt på én enhet.

Haven er et kjøremiljø for MindooDB-apper. MindooDB-apper er små webverktøy bygget med MindooDB App SDK. Haven starter hver av dem i en iframe med sandkasse på en egen origin, gir den et avgrenset innsyn i dataene du valgte å dele, og formidler hver lesing og skriving gjennom en sikker bridge. Hostede apper kan til og med serveres av Havens egen service worker og fortsette å virke når nettet er borte.

Haven leveres med lyst og mørkt tema som følger systeminnstillingen som standard, og som kan byttes manuelt. Det aktive temaet sendes live videre til enhver MindooDB-app som kjører inne i Haven, så innebygde apper matcher Havens utseende automatisk, uten ekstra arbeid.

Under alt dette ligger det samme løftet MindooDB gir overalt ellers: nøkler blir værende på enhetene, servere ser aldri annet enn chiffertekst, og et fullstendig servertyveri gir fortsatt ingenting lesbart. Haven er laget for å være den mest behagelige måten å leve med det løftet på.

## Kjernebegrepene på fem minutter

Forstår du denne håndfullen med ord, leser resten av håndboken seg selv.

En brukeridentitet er kontoen din inne i Haven. Det er en lokalt kryptert fil som inneholder de offentlige opplysningene dine og de krypterte private nøklene dine, og som låses opp enten av en passnøkkel på enheten din eller av et passord du har valgt. Identiteter opprettes lokalt i nettleseren din og forlater den aldri med mindre du velger å eksportere dem. Haven kan holde flere identiteter side om side og bytte mellom dem fra topplinjen. Å miste alle hemmeligheter som låser opp en identitet, er permanent — det finnes ingen lenke for å nullstille, fordi ingen utenfor enheten din har nøkkelen.

En tenant er teamets private arbeidsområde inne i MindooDB. Alle som kan se et bestemt sett med databaser, er medlemmer av samme tenant. Tenanter inneholder en katalogdatabase (der brukerregistreringer og innstillinger for hele tenanten ligger), én eller flere applikasjonsdatabaser og et sett med krypteringsnøkler. Tenanter opprettes utelukkende på klientsiden og kan publiseres til en server når du er klar til å samarbeide.

En lokal replika er den nettleserlokale, synkroniserte kopien av databasene i en tenant. Det er dette som gjør at Haven føles umiddelbart. Å jobbe fra den lokale replikaen er raskt, virker offline og er den anbefalte måten å bla og redigere på.

En database er en samling beslektede dokumenter inne i en tenant — kontakter, fakturaer, notater, hva teamet nå trenger. Et dokument er én oppføring inne i den databasen. Hvert dokument er en Automerge CRDT, teknologien som lar to personer redigere det samme dokumentet samtidig og få endringene sine flettet sammen automatisk, uten noen konfliktdialog.

Hver endring i et dokument signeres med forfatterens private nøkkel og legges til dokumentets historikk. Hver endring er også kryptografisk lenket til endringen før den, litt som en blokkjede, slik at kjeden av redigeringer blir en manipulasjonssikker rekkefølge og ikke en pose med løse revisjoner. Den historikken er det Haven viser i Databaseutforskeren og i dokumenthistorikken. Fordi endringer er signert og kjedet, kan ingen omskrive fortiden i det stille: å endre eller fjerne en tidligere endring ville brutt hver eneste lenke som følger etter.

En KeyBag er et lokalt, kryptert lager for krypteringsnøklene en tenant trenger, som åpnes av identiteten som eier det. Hver bruker har sin egen KeyBag i nettleseren sin. En standardnøkkel deles med alle medlemmer av en tenant; navngitte nøkler er ekstra nøkler som kan gis til en mindre gruppe for følsomme dokumenter.

En virtuell visning er et regnearklignende tre som filtrerer, kategoriserer, sorterer og summerer dokumenter. En visning kan hente fra én database, flere databaser eller til og med flere tenanter, og det er slik du svarer på spørsmål på tvers av data i stedet for bare inne i én database.

Arbeidsområdet består av fliser på sider, samlet i grupper. En flis — også kalt en chicklet — er et kort du kan dra og endre størrelsen på, og som åpner en database, starter en app eller viser et notat, en nettside, en video eller et diagram. En side er en fane full av fliser. En gruppe samler beslektede fliser under en felles, fargekodet overskrift.

En applikasjonsregistrering er den lagrede definisjonen Haven har av en MindooDB-app: hvor den ligger, hvordan den kjører, og hvilke databaser eller visninger den får se. Når en app starter, snakker den med Haven gjennom en bridge (noen ganger kalt app-connectoren), den sikre kanalen som lar Haven håndheve rettighetene du ga. Sandkassen er isolasjonen nettleseren håndhever, og som hindrer en app i å nå Havens lagring, informasjonskapsler eller andre apper.

Det er byggeklossene. Alt annet i Haven er en skjerm for å arbeide med dem.

## Finn fram i Haven

Haven samler alt på én flate. En smal topplinje går tvers over toppen, og under den ligger Arbeidsområdet — siden du starter på, kommer tilbake til og navigerer fra. Det finnes ingen sidekolonne og ingen egen menystruktur å lære seg.

Topplinjen er den samme på hver skjerm. Til venstre er ordmerket MindooDB Haven en lenke tilbake til Arbeidsområdet, uansett hvor du befinner deg. Til høyre ligger to ting: en identitetsbrikke som viser den aktive brukeren, og en Hjelp-knapp. Trykk på brikken for å åpne identitetsveksleren; høyreklikk eller trykk og hold på den for en hurtigmeny som bytter mellom lys og mørk modus eller låser økten. Hjelp-knappen åpner en kontekstuell hjelpeskuff for skjermen du er på. Hver skjerm har sin egen artikkel, skrevet i samme vennlige stil som denne håndboken, pluss en kort veiledet gjennomgang som løfter fram kontrollene det er verdt å kjenne — føler du deg fortapt, er den knappen det første du bør prøve. På telefon eller nettbrett vil Haven av og til dytte deg fra topplinjen til å legge den til på Hjem-skjermen.

Arbeidsområdet åpnes på en fane som heter Start, og Start er Havens inngangsdør. Øverst går det en rad med seks snarveisfliser, én for hver av Havens egne skjermer: Oppsettsveiviser for nytt miljø, Haven App Store, Synkroniser med server, Hurtigskann, Virtuelle visninger og Innstillinger. Hver av dem får sitt eget avsnitt senere i håndboken. Under snarveiene lister Start opp én flis for hver applikasjon du har installert, så den fungerer også som katalogen over hva som er tilgjengelig for deg. Dobbeltklikk på en flis for å åpne den, eller bruk ⋮-knappen i hjørnet for handlingene som hører til den.

Start er bevisst fastlåst. De seks snarveiene ligger alltid på samme sted og kan ikke flyttes, fjernes eller omorganiseres, og Start er ikke der dine egne fliser hører hjemme — det er den ene siden du kan stole på ser lik ut i morgen. Alt du selv setter opp, ligger på sidene du oppretter ved siden av Start, beskrevet under Arbeidsområde nedenfor.

Appskuffen er måten du beveger deg mellom tingene du har åpne på. Når en applikasjon kjører eller en Haven-skjerm er åpen, dukker det opp et lite pilhåndtak øverst i innholdsområdet; klikker du på det, glir en skuff ned i to deler. Visninger lister opp Haven-skjermene du har åpne — Synkronisering, Innstillinger, Virtuelle visninger, oppsettsveiviseren — og Apper lister opp MindooDB-applikasjonene som kjører nå. Over begge ligger oppføringen Tilbake til arbeidsområdet. Fra en applikasjons flis i skuffen kan du også synkronisere appens lokale databaser mot serveren, laste den på nytt, åpne en infodialog eller lukke den.

To hurtigtaster gjør skuffen verdt å lære skikkelig. Cmd+Shift+Enter tar deg tilbake til Arbeidsområdet uansett hvor du er, også inne i en applikasjon som kjører, og Cmd+Shift+Space åpner og lukker skuffen. På Windows og Linux trykker du Ctrl i stedet for Cmd. Haven videresender begge til innebygde applikasjoner, så de fortsetter å virke selv når en app har tastaturfokus.

Det du åpner, blir værende åpent. Start en applikasjon eller åpne Synkroniseringssiden, gå et annet sted, og den sitter fortsatt i skuffen når du kommer tilbake, med rulleposisjon, ulagrede endringer og åpne faner urørt.

Når du installerer Haven på en telefon og starter den fra Hjem-skjermen, åpnes den i frittstående modus, som fjerner nettleserens adresselinje og fanerad. Enkelte skjermer inne i Haven — mest de oppslukende, som en app som kjører i fullskjerm — skjuler topplinjen av samme grunn.

## De første 10 minuttene dine

Første gang du åpner Haven, finnes det ingenting å finne og ingenting å konfigurere: du tas rett inn i oppsettsveiviseren, som gjør hele begynnelsen — identitet, administrator, tenant eller det å bli med i et eksisterende team — om til en kort, veiledet flyt. Haven avgjør dette ved å se på enheten. Så snart den finner både en navngitt brukeridentitet og en tenant, lander du på Arbeidsområdet når du åpner Haven; inntil da lander du i veiviseren. Du kan komme tilbake til den når du vil, fra flisen Oppsettsveiviser for nytt miljø på Start, som også er måten du legger til en ny tenant senere. Alt veiviseren gjør, kan gjøres for hånd via Innstillinger → Bruker-ID-er og Innstillinger → Tenants, men veiviseren er den klart enkleste veien, så bruk den når du kan.

Veiviseren åpner med en kort presentasjon (ende-til-ende-kryptert, lokal-først, nulltillitsservere) og tre store knapper: Opprett en tenant, Bli med i et team og Åpne tenants. Under dem forklarer to kort hva hver vei faktisk gjør. Har Haven allerede en opplåst identitet, sier et lite banner fra — veiviseren gjenbruker den gjerne og hopper over identitetstrinnet hvis du vil.

### Vei én: starte din egen tenant

Starter du fra bunnen, trykk Opprett en tenant. Veiviseren tar deg gjennom fire trinn på én og samme side.

Trinn én, opprett din personlige brukeridentitet. Dette er kontoen din inne i Haven — en liten, lokalt kryptert fil som inneholder de offentlige opplysningene dine og de krypterte private nøklene dine. Du kan enten gjenbruke identiteten som allerede er låst opp i topplinjen, eller opprette en helt ny ved å skrive inn et brukernavn (for eksempel `cn=user/o=acme`).

Velg så hvordan du vil låse opp den identiteten fra dag til dag. Haven forhåndsvelger Passnøkkel når nettleseren din støtter det, fordi det både er det enkleste og det sterkeste valget: enheten din spør etter Face ID, Touch ID, Windows Hello eller en sikkerhetsnøkkel, og utleder nøkkelen som åpner de private nøklene dine lokalt. Passord er alternativet, og det er riktig valg på en delt enhet der noen andre kjenner opplåsingskoden, eller når du vil at den samme identiteten skal virke i konsollet. Uansett blir hemmeligheten på denne enheten — det finnes ingen gjenopprettingsflyt og ingen server som kan låse opp identiteten din for deg, så ta vare på hemmeligheten du valgte, før du går videre. Du kan legge til den andre metoden senere fra Innstillinger → Bruker-ID-er.

Trinn to, sett opp en egen admin-identitet. MindooDB holder bevisst tenant-administratoren og den daglige appbrukeren fra hverandre, slik at én kompromittert hemmelighet ikke kan overta både katalogadministrasjonen og det daglige dokumentarbeidet. Her velger du hvordan admin-identiteten beskyttes: la Haven lage en passfrase på seks ord, eller skriv inn ditt eget passord med det vanlige gjentakelsesfeltet. Den genererte vises én gang, med knapper for å kopiere den eller laste den ned som tekstfil, og en avkrysningsboks som bekrefter at du har lagret den, slik at du ikke kan hoppe forbi ved et uhell. Uansett er den bevisst ikke en passnøkkel: en administrator du bare kan låse opp med Face ID på denne enheten, er en administrator du mister sammen med enheten, og administratorarbeid er nettopp det du trenger etter å ha byttet laptop. Oppbevar den der du oppbevarer de andre nødlegitimasjonene dine.

Trinn tre, opprett selve tenanten. Haven genererer tenant-ID-en for deg, og den kan ikke endres etterpå. Det er tilsiktet: så snart flere team deler en MindooDB-server, må tenant-ID-er være unike, og en ID noen har skrevet inn for hånd, er en ID som før eller siden kolliderer med en annens. Det du derimot velger, er tenant-etiketten — et kort, minneverdig navn så du kjenner igjen denne tenanten senere — og enhver administrator kan gi den nytt navn når som helst, fordi etiketten bare finnes for mennesker. Haven genererer så tenantens krypteringsnøkler, en standardnøkkel for innholdet ditt og en til for tilgangskatalogen, lagrer dem i den lokale KeyBag-en din og kobler opp begge identitetene. Alt blir liggende lokalt i nettleseren din på dette stadiet; ingenting er sendt til en server ennå.

Trinn fire, alt er klart. Haven slipper deg inn i det tomme Arbeidsområdet ditt, allerede opplåst, allerede inne i den nye tenanten. Når du er klar til å samarbeide, publiser tenanten til en MindooDB-server: Synkroniseringssiden tilbyr en Overfør til server-knapp for enhver tenant som fortsatt bare er lokal, og det samme finnes under Innstillinger → Tenants.

### Vei to: bli med i et eksisterende team

Har en kollega allerede satt opp en tenant på en MindooDB-server, trykk Bli med i et team i stedet. Veiviseren bruker det samme firetrinnsoppsettet, men følger MindooDBs tretrinns innmeldingshåndtrykk, der de private nøklene dine aldri forlater denne enheten.

Trinn én, opprett din personlige brukeridentitet (eller gjenbruk den aktive), akkurat som i den andre veien.

Trinn to, send en innmeldingsforespørsel. Haven bygger en URL for innmeldingsforespørselen ut fra de offentlige nøklene dine — ingen hemmeligheter — og viser den til deg med en Kopier tilgangsforespørsel-knapp. Send den URL-en til tenant-administratoren gjennom hvilken kanal du vil (e-post, chat, et sakssystem); den er trygg å dele åpent fordi den bare inneholder de offentlige nøklene dine. Administratoren åpner sin Haven, kjører Gi tenant-tilgang på forespørselen din og sender tilbake to ting: en URL for innmeldingssvar og et kort delt passord. Viktig: det delte passordet må komme gjennom en separat, sikker kanal — en telefonsamtale, en annen meldingstjeneste eller ansikt til ansikt — fordi svaret bærer krypteringsnøklene for arbeidsområdet.

Trinn tre, fullfør innmeldingen. Lim URL-en for innmeldingssvaret inn i veiviseren, skriv inn server-URL-en som er vert for tenanten (det finnes ettklikkssnarveier for kjente servere), og skriv det delte passordet administratoren ga deg separat. Haven validerer serveren, henter de første katalogdataene og legger tenanten til i Haven-en din.

Trinn fire, du er inne. Haven slipper deg inn i den nylig påmeldte tenanten, og Arbeidsområdet er klart til å fylles med fliser.

### Etter veiviseren

Når velkomstveiviseren er ferdig, er den daglige veien den samme, uansett hvilken rute du tok.

Åpne Arbeidsområdet. Start har allerede sine seks snarveisfliser; det den ennå ikke har, er noe av ditt. Legg til en side ved siden av Start fra Legg til-menyen, og bruk så den samme menyen til å sette en databaseflis på den, pekende mot en av databasene i tenanten din. Dobbeltklikk flisen for å åpne Databaseutforskeren og se dokumentene i den.

Installer en app. Åpne Haven App Store fra Start, finn noe som ser nyttig ut, og installer det. Den dukker opp som en flis på Start med én gang, og derfra kan du plassere den på en av dine egne sider.

Kjør en synkronisering. Åpne Synkroniser med server fra Start og trykk Synkroniser alle, eller bruk Synkroniser på enkeltraden hvis du bare vil oppdatere én database. Når statuskolonnen viser en grønn hake, er den lokale replikaen din à jour med serveren.

Kom tilbake til Arbeidsområdet og fortsett å legge til fliser — applikasjoner, notater, nettsider, dashbord, alt som gjør at arbeidsområdet ditt føles som hjemme.

Føles et trinn abstrakt, åpne Hjelp-knappen på den skjermen. Hjelpen i appen har en veiledet gjennomgang som løfter fram nøyaktig hva du skal klikke på. Og du kan alltid åpne oppsettsveiviseren igjen fra flisen på Start — den gjenbruker gjerne en eksisterende identitet eller hjelper deg med å lage flere.

### Haven er multi-tenant av design

Ingenting stopper ved én tenant. Velkomstveiviseren kan kjøres på nytt når som helst, og hver nye tenant er kryptografisk uavhengig av alle andre — egne krypteringsnøkler, egen KeyBag-oppføring, egen admin-kjede, egen signert historikk. Den uavhengigheten er det som gjør det trygt å holde svært ulike sammenhenger under samme tak.

Et vanlig oppsett er å kjøre tre eller fire tenanter parallelt: én for jobben, én for private ting som husholdningsplanlegging eller et sideprosjekt, og enda en delt med et partnerselskap for samarbeid på tvers av organisasjoner. Du kan bruke den samme brukeridentiteten i alle sammen, eller lage en egen identitet per tenant — valget er ditt, for ingenting knytter tenantene sammen utover at de tilfeldigvis bor i samme nettleser.

Haven er genuint multi-tenant, ikke enkelt-tenant-med-bytting. Du kan ha flere tenanter opplåst og aktive samtidig, blande dataene deres inne på én arbeidsområdeside, og knytte databaser fra ulike tenanter bak separate logiske navn til den samme applikasjonen, slik at den kan jobbe på tvers av organisasjonsgrenser uten noen gang å se mer enn den skal. Virtuelle visninger tar dette et steg videre: én enkelt visning kan hente fra flere databaser på tvers av flere tenanter og kategorisere, sortere og summere dokumentene deres som om de var ett datasett. For eksempel kan en visning for personlig planlegging kombinere den private gjøremålslisten din med jobboppgavene du er tildelt i firmatenanten, selv om de to datasettene er kryptert med helt forskjellige nøkler og synkronisert til helt forskjellige servere.

Legg til tenanter når en ny sammenheng dukker opp. Å la dem ligge side om side koster lite, og den kryptografiske adskillelsen betyr at du aldri trenger å bekymre deg for at data lekker fra den ene til den andre.

## Bruke Haven på mer enn én enhet

Haven holder dataene dine i nettleseren den kjører i. Det er dette som gjør den rask, og som holder nøklene dine unna andres servere, men det betyr også at en ny nettleser — Safari på iPhone-en din, en jobb-laptop, enda en installert kopi av Haven på samme telefon — starter som en fremmed. Den har sitt eget lager, sine egne enhetsnøkler og ingen måte å lese noe på før en enhet du allerede stoler på, slipper den inn. Dette avsnittet handler om det øyeblikket.

To forskjellige tillatelser er i spill, og det å holde dem fra hverandre er det som gjør modellen trygg. Den første er tillatelse til å synkronisere: en tenant-administrator gir brukernavnet ditt tilgang, og fra da av er serveren villig til å gi enhetene dine krypterte data. Den andre er tillatelse til å lese: nøklene som gjør den chifferteksten om til dokumenter igjen. En server kan gi den første, fordi den bare flytter byte rundt, men den kan aldri gi den andre, siden den aldri har hatt en nøkkel. Så en helt ny enhet kan fullføre en synkronisering, ha hver eneste byte av en database liggende lokalt, og fortsatt ikke ha noe i den som den kan lese. Haven lister aldri opp et dokument den ikke kan dekryptere, så symptomet er ikke en rad som nekter å åpne seg: det er en database som ser tom ut, eller en visning som er mye kortere enn du ventet, på en enhet som nettopp meldte om en vellykket synkronisering. Det er ikke en feil og ikke en halvferdig innmelding; det er slik det er ment, og banneret som beskrives nedenfor, er det som skiller de to. Databaseutforskeren setter også et tall på det: overskriften teller dokumentene du kan lese og sier, når denne enheten har dokumenter nøklene dine ikke kan åpne, hvor mange som er skjult — «Dokumenter (3) · 7 skjult» er en enhet som har ti og kan lese tre. Tallet teller det som har kommet hit, ikke det tenanten har, så det vokser etter hvert som en synkronisering henter mer inn.

Det som bygger bro over gapet, er brukernøkkelen din. Hver person i en tenant har nøyaktig én — et krypteringsnøkkelpar som tilhører deg, ikke en enhet eller tenanten selv. Den offentlige halvdelen publiseres inne i tenanten slik at kolleger og administratorer kan kryptere til deg, og det er slik tenantens standardnøkkel når fram til deg i utgangspunktet. Den private halvdelen finnes bare på enhetene du har godkjent. Å godkjenne en enhet betyr å skrive enda en kopi av den private halvdelen inn i tenantens brukerkatalog, pakket inn slik at bare den nye enhetens egen nøkkel kan åpne den. Serveren lagrer og videresender den kopien som alt annet, uten noen gang å kunne lese den.

På den nye enheten ser du et banner langs bunnen av skjermen: Denne enheten venter på godkjenning. Det navngir hvilken tilgang som står fast — for eksempel «Tenant acme · på Server1/ACME», der andre halvdel er serverens eget kanoniske navn, det samme som Tenants-fanen viser, med adressen som reserve hvis den aldri meldte inn noe — fordi den samme tenanten kan synkroniseres gjennom mer enn én server samtidig, og et blankt «venter» sier deg ingenting i den situasjonen. Under navngir det nøklene du mangler, så du vet hva som kommer tilbake når ventetiden er over: dokumenter som trenger standardnøkkelen, blir liggende skjult til da. Har du meldt deg inn i flere tenanter fra denne enheten, forteller en linje hvor mange flere som står i kø bak denne. Banneret sitter bevisst på hver side og ikke bare i arbeidsområdet, fordi en enhet uten nøkler er stengt ute overalt, og veien ut må være innen rekkevidde. Sjekk på nytt leser katalogen på nytt der og da; Åpne gjenoppretting fører til siste utvei, som beskrives sist i dette avsnittet.

På en enhet som allerede er godkjent, kommer den andre halvdelen av håndtrykket som en dialog kort tid etter at du låser opp: Godkjenn en ny enhet. Den viser enhetens etikett, den samme tenant-og-server-linjen så du ser hva du er i ferd med å gi fra deg, og når enheten ble lagt til. Godkjenn denne enheten skriver den innpakkede kopien av brukernøkkelen din og sender den ut. Ikke nå utsetter spørsmålet til neste gang Haven starter, og det er riktig svar når du står midt i en oppgave og enheten faktisk er din. Ikke spør igjen er det bestemte svaret: enheten registreres som avvist, alle godkjente enheter slutter å spørre om den, og den vises som Skjult i enhetslisten din. Å avvise kaster ikke enheten ut av tenanten — den kan fortsatt synkronisere — den får bare aldri nøkler, så alt den synkroniserer, forblir usynlig for den. Når flere enheter venter, spør Haven om dem én om gangen.

Godkjenning går gjennom tenantens brukerkatalog, noe som gjør den til en synkronisering og ikke et direkte håndtrykk. De to enhetene snakker aldri sammen direkte, og enheten som godkjenner, trenger ikke å bli stående åpen: godkjenningen skrives, sendes til serveren og plukkes opp av den ventende enheten neste gang den henter — ved neste katalogsynkronisering, når du trykker Sjekk på nytt, eller når Haven starter neste gang. Hvis ingen av enhetene når serveren, skjer det ingenting før en av dem gjør det.

Innstillinger → Bruker-ID-er har hele bildet under Dine enheter, og det er dit du går når en dialog ble lukket eller en avvisning må gjøres om. Hver rad er én enhet med etiketten sin, når den ble lagt til, hvilken tenant den hører til, og statusen sin: Godkjent, Venter på godkjenning eller Skjult. Ventende enheter får en Godkjenn-knapp, skjulte en Tillat likevel-knapp som setter enheten tilbake i ventetilstand så den kan godkjennes på vanlig måte. Én regel overrasker folk første gang: godkjenningen må komme fra en enhet som allerede er godkjent. En enhet som fortsatt venter på sin egen godkjenning, ser den setningen i stedet for en knapp og kan ikke slippe seg selv inn — kunne den det, ville hele mekanismen vært pynt. Det betyr også at enhet nummer to på en publisert tenant må godkjennes fra den første, så godkjenn den mens du fortsatt har begge.

Ble en tenant aldri publisert, dukker ingenting av dette opp. Det finnes ingen brukerkatalog på en server å slå opp i og ingen annen enhet å spørre, så den første enheten forsegler sin egen brukernøkkel og går videre. Flyten begynner å bety noe i det øyeblikket en tenant bor på en server og en enhet nummer to dukker opp.

Det finnes ett tilfelle til der Haven ikke spør om noe som helst. Gir du selv tilgang til innmeldingsforespørselen for den nye enheten din, fra en enhet som allerede har brukernøkkelen din, skrives kopien som en del av det å gi tilgang, og nykommeren kommer inn med lesetilgang med én gang. Stillhet er det gode utfallet der, ikke et trinn som mangler. Det er når noen andre godkjenner innmeldingen — typisk en tenant-administrator som registrerer deg — at den nye enheten havner i ventetilstand og trenger en av dine egne enheter til å gjøre jobben ferdig.

Noen ganger kan ikke Haven avgjøre det. Et gult banner som sier Haven kunne ikke fastslå ennå om denne enheten er godkjent, betyr at brukerkatalogen ikke kunne leses i det hele tatt — som regel fordi serveren ikke er tilgjengelig — og ikke at noen har avvist deg. Sjekk nettverket og trykk Sjekk på nytt. Der en ny sjekk aldri kunne endre svaret, holder Haven seg heller stille enn å la et banner bli stående for alltid.

Den ene situasjonen denne flyten ikke kan reparere, er å miste alle godkjente enheter på én gang, for da er det ingen igjen til å godkjenne erstatningen. Det er det tenant-nødutskriften på Backup-fanen er til for, og derfor lenker ventebanneret rett til Gjenoppretting-fanen. Skriv ut én per tenant mens alt er rolig; avsnittet om backup og gjenoppretting forklarer hva den inneholder.

## Arbeidsområde

Arbeidsområdet er hjemmet ditt til daglig. Du ordner databaser, applikasjoner, notater, nettsider, videoer og diagrammer som fliser du kan dra rundt på flere sider, som hjemskjermer på en telefon. Oppsettet er personlig: som standard lagres det bare i denne nettleseren, så det lastes umiddelbart og virker offline. Vil du ha den samme organiseringen på de andre enhetene dine, lagrer innstillingen Arbeidsflate som følger med under Innstillinger → Generelt det i tenanten din, kryptert for deg alene.

Sider er fanene øverst i Arbeidsområdet. Den første er alltid Start, beskrevet under Finn fram i Haven: Havens egne seks snarveier pluss en flis for hver installerte applikasjon. Start er skrivebeskyttet, så du kan ikke slippe dine egne fliser på den eller flytte om på det som er der, og det er den ene siden som alltid ser lik ut.

Alt annet er ditt. Legg til så mange sider ved siden av Start som du vil — én per prosjekt, én per rolle, én for daglige dashbord, én for personlige lenker — hver med sitt eget rutenett av fliser. Høyreklikk en sidefane for å gi den nytt navn, flytte den eller slette den.

Fliser er kortene i rutenettet. Dra en flis etter overskriften for å flytte den, dra i hjørnet for å endre størrelsen, eller høyreklikk for hele hurtigmenyen. Slipp en flis på en annen sidefane for å flytte den dit. Slipp en flis på en annen flis for å starte en gruppe.

Grupper samler beslektede fliser under en felles, fargekodet overskrift. En gruppe er en god måte å holde flisene for ett prosjekt visuelt samlet på — for eksempel databasen, appen som kjører, og et referansenotat for det samme teamet. Høyreklikk gruppeoverskriften for å gi den nytt navn, endre farge eller oppheve grupperingen så flisene blir vanlige kort igjen.

Flere flistyper bor i det samme rutenettet.

En databaseflis peker på én MindooDB-database. Dobbeltklikk den for å åpne Databaseutforskeren. Bruk hurtigmenyen til å bytte hvilken kopi av databasen flisen viser — en lokal replika for fart og offline-bruk, eller et direkte servermål for den ferskeste tilstanden. Databasefliser husker tenanten, databasen og kilden du sist brukte, så de fungerer også som et praktisk bokmerke tilbake til resten av MindooDB.

En applikasjonsflis starter en MindooDB-app, og to separate innstillinger avgjør hvordan den oppfører seg. Flisens egen Visningsmodus er enten Startikon, et kort du dobbeltklikker, eller Innebygd, som kjører appen rett inne i arbeidsområdekortet og er perfekt for små verktøy man bare kaster et blikk på, som et registreringsskjema eller et minidashbord. Registreringens Kjøremodus avgjør så hva en start faktisk gjør: Innebygd i Haven åpner appen i full bredde inne i Haven-vinduet, der Appskuffen håndterer bytting, mens Åpne i nytt vindu gir den en egen nettleserfane — nyttig for en ekstra skjerm, eller for å lese Haven og appen side om side. Apper som åpnes inne i Haven, fortsetter å kjøre i bakgrunnen mens du navigerer andre steder, så rulleposisjon, ulagrede endringer og åpne faner er der fortsatt når du bytter tilbake.

Tekstfliser rommer formaterte notater. Webfliser bygger inn hvilken som helst URL som en mininettleser, og det er slik du holder et partnersystem eller et annet teams dashbord ved siden av MindooDB-dataene det dokumenterer. Videofliser spiller av YouTube-innhold til opplæring og gjennomganger. Mermaid-fliser gjengir levende arkitekturdiagrammer og flytskjemaer rett i rutenettet. Disse innholdsflisene er personlige — de bor bare i denne nettleseren — så de er ideelle for jukselapper, daglige lenker og levende referansemateriale.

En søkelinje øverst i Arbeidsområdet filtrerer fliser på tvers av sider etter navn, database, tenant, etikett eller server. På Start kan du også sortere det som listes der, etter sist brukt, etter tenant eller alfabetisk, noe som blir den raskeste måten å finne fram på når du har installert mer enn en håndfull applikasjoner.

## Applikasjoner og Haven App Store

MindooDB-apper er små webverktøy som kjører inne i Haven med et avgrenset innsyn i dataene dine. Å skaffe seg en er ett klikk i Haven App Store; alt etterpå — start, konfigurasjon, oppdatering, fjerning — skjer fra appens egen flis på Start.

Haven App Store er katalogen over ferdige MindooDB-applikasjoner, og den åpnes som en dialog oppå Arbeidsområdet i stedet for å ta deg et annet sted. Bla i katalogen, åpne en oppføring for å lese beskrivelsen, skjermbildene og versjonen, og trykk så Installer. Haven spør hvilken tenant appen skal jobbe i og hva den skal hete, og Installer nå fullfører jobben. Det finnes ikke noe registreringsskjema å fylle ut: Haven skriver ett for deg ut fra katalogoppføringen, gir appen databasene den erklærer, og appen dukker opp som en flis på Start, klar til å startes. Har en hostet app en nyere bygging som venter, bærer App Store-flisen et lite merke med antallet tilgjengelige oppdateringer.

En registrering er den lagrede kontrakten mellom Haven og en app: Haven lover å starte den slik registreringen beskriver og å eksponere bare de dataene tilknytningene tillater, og appen går med på å gå gjennom Havens SDK-connector for hver lesing og skriving. Å installere fra App Store lager en automatisk, og det er derfor de fleste aldri trenger å tenke på begrepet i det hele tatt. Det begynner å bety noe den dagen du vil endre hva en app har lov til å se.

Alt du kan gjøre med en installert app, henger under ⋮-menyen på Start-flisen dens. Start applikasjon starter den med den aktive brukeren, eller tar deg inn i den eksisterende økten hvis den allerede kjører, i stedet for å starte en til. Konfigurer applikasjon åpner registreringen for redigering, og det er der hostingen, kjøremodusen og datatilknytningene som beskrives nedenfor, ligger; endringer trer i kraft neste gang appen starter, og ingen kodeendringer trengs i appen selv. Om denne applikasjonen viser metadataene dens, som app-ID-en og gjeldende versjon. Se etter oppdateringer dukker opp på apper som serveres fra en hostet bundle, og henter en nyere bygging hvis utgiveren har sendt ut en. Fjern applikasjon avinstallerer den igjen. App Store-flisen har én ekstra oppføring for seg selv, Importer applikasjon, for å hente inn en ferdigpakket registrering som ikke kom fra katalogen.

To ting avgjør hvordan Haven serverer en app. For det første hvor koden bor. En Ekstern URL peker på en utviklingsserver eller en utplassert webapp som kjører et annet sted; den bruker du mens du utvikler, eller når et annet team hoster appen. En Hostet bundle er et pakket sett med webressurser importert inn i Haven selv. Når den først er lagret lokalt, kan Haven levere bundelen gjennom sin egen service worker, som betyr at appen starter fra lokal lagring også når det ikke finnes nett — dette er veien til apper som virkelig virker offline. Hostet modus bruker også en nettverksliste du styrer; tom betyr ingen ekstern nettverkstilgang. Se [hosted-app isolation](hosted-app-isolation.md) for sandkassen, Vite-pluginen og hvorfor lokal `vite dev` blir liggende på en ekstern inngangs-URL. For det andre hvordan den kjører. Innebygd i Haven kjører appen i en iframe inne i Haven-vinduet, der Appskuffen håndterer bytting. Åpne i nytt vindu starter den som en egen nettleserfane i stedet, noe som er nyttig for en ekstra skjerm.

Den delen av registreringen som faktisk beskytter deg, er datatilknytningen. For hver database du vil at appen skal se, velger du det logiske navnet appen skal adressere den med, og rettighetene du gir: kun lesing eller lesing og skriving, om sletting, vedlegg, revisjonshistorikk og oppretting av appdefinerte virtuelle visninger skal tillates. Du kan også knytte databaser fra ulike tenanter eller ulike servere bak separate logiske navn, noe som lar én app jobbe på tvers av grenser uten noen gang å se mer enn den skal.

Når en app starter, snakker den ikke med MindooDB-lagringen direkte. Den kaller SDK-connectoren, som åpner en økt med Haven, og hver lesing, skriving, spørring, vedleggsoperasjon eller historikkoppslag går gjennom den connectoren. Haven validerer hver forespørsel mot tilknytningen og rettighetene du satte opp, så selv om appen prøvde å oppføre seg dårlig, ville bridgen nekte.

Registreringer reiser som JSON-pakker. Eksporter, inne i dialogen Konfigurer applikasjon, skriver en; Importer applikasjon på App Store-flisen leser den tilbake. En pakke kan bære med seg filene i den hostede bundelen sammen med definisjonen, så en app utviklet i én nettleser kan gis videre til en kollega eller flyttes inn i et annet miljø uten at noen må bygge registreringen på nytt for hånd.

Ikke alle apper kommer fra katalogen, og butikkens Ny app-meny dekker resten. Fra URL registrerer en app som ligger på en adresse du limer inn — en fork, en forhåndsvisningsutplassering eller en bygger som kjører på din egen maskin; Haven leser appens `haven-app.json` fra den adressen og viser deg hva den ber om før den skriver noe som helst. Ny tom app åpner en tom registrering når du vil fylle inn hosting og tilknytninger for hånd. Skreddersydd, laget av KI fører til App Builder, som neste avsnitt handler om.

En god tommelfingerregel når du utvider en apps tilgang: start med kun lesing på én enkelt database, få appen til å kjøre, og gi først da mer. Det er mye enklere å legge til skrivetilgang senere enn å ta den bort i all hast.

## Bygge en app med App Builder

Én app i butikken finnes for å lage andre apper. App Builder tar en beskrivelse av verktøyet teamet ditt mangler — en oppgavetavle, en bestillingsliste, en vaktplan — og gjør den om til en fungerende Haven-applikasjon: en KI-agent skriver koden, den publiseres på nettet på sin egen adresse, og Haven tilbyr den for installasjon. Ingenting på din side innebærer programmering, og det som kommer ut, er en ekte applikasjon og ikke en demo.

Du installerer den fra Haven App Store som alt annet. Første kjøring ber deg koble til tre kontoer, og det er den eneste tekniske delen av hele affæren. GitHub tar vare på appens kildekode, Cloudflare publiserer den, og Cursor leverer KI-en som skriver den. GitHub og Cloudflare kobles til gjennom sine egne samtykkeskjermer med ett klikk hver, uten noen konto-ID eller eiernavn å lete opp noe sted. Cursor har ingen samtykkeflyt, så du limer inn en API-nøkkel fra dashbordet der — og skyagentene byggeren starter, er ikke inkludert i Cursors gratisplan. Det er også den ene du kan utsette: uten en Cursor-nøkkel blir prosjektet fortsatt opprettet og publisert, det kommer bare tomt.

Fra da av er det å bygge en app et navn, én setning om hva den skal til for, og en beskrivelse av hva den skal gjøre, skrevet i vanlig språk og ikke i teknisk sjargong. Å trykke på knappen setter fire ting i gang. Prosjektet opprettes fra den offisielle startmalen, som allerede bærer med seg App SDK-dokumentasjonen og en veileder i beste praksis, så agenten jobber ut fra grensesnittene som faktisk finnes, i stedet for å gjette på dem. Appen får sin egen webadresse, koblet til Cloudflares byggepipeline slik at hver senere push utplasserer den på nytt av seg selv. En skyagent tar imot beskrivelsen og begynner å skrive, og lager et passende appikon underveis. Og når den er ferdig, gir byggeren appen videre til Haven.

Du kan følge med på alt sammen. Hvert trinn melder fra om hva det gjorde, og agentens arbeid er synlig mens det pågår, så du følger med og gir tilbakemelding i stedet for å vente på en svart boks. Den kanalen blir stående åpen etterpå: å be om neste funksjon er enda en beskrivelse mot det samme prosjektet, og agenten fortsetter der den slapp.

Haven installerer resultatet slik den installerer alt annet. Den leser den ferdige appens egen beskrivelse og spør deg først, og lister opp databasene, rettighetene og nettverkstilgangen den nye appen ber om. Når du har godkjent, er den en flis i Arbeidsområdet ditt som alle andre, klar til å kjøre i fullskjerm eller innebygd i kortet.

Hva du eier til slutt, er verdt å si tydelig. Koden er et helt vanlig Git-repositorium på din egen GitHub-konto, bygget på den samme App SDK-en som førsteparts-appene bruker, med hele plattformen åpen for den: databaser, virtuelle visninger, offline drift, sanntidssynkronisering, Havens tema. KI-en kan byttes ut — pek Claude Code, Codex eller dine egne hender mot repositoriet i stedet, og Cloudflare publiserer på nytt det som kommer, uansett hvem som skrev det. Og fordi appen ligger på en offentlig adresse, kan en kollega du sender lenken til, legge den samme appen til i sin egen Haven.

Legitimasjonen får omhyggelig behandling, for det er tre av dem og de er mektige. De ligger i ett enkelt dokument i din egen App Builder-database, kryptert for deg personlig, så en delt database avslører dem ikke, og den neste appen spør ikke om dem igjen. GitHub-tokenet forlater aldri nettleserfanen i det hele tatt. Cloudflare-tokenet og Cursor-nøkkelen når derimot byggerens server, for de kallene en nettleser ikke har lov til å gjøre, og ingenting beholdes etterpå. Ingen legitimasjon gis noen gang til kodeagenten: publiseringen går gjennom Cloudflares egen Git-integrasjon, som ikke trenger noen token-overlevering, nettopp for at en skymaskin aldri skal få noe som kan utplassere.

App Builder ber Haven om én uvanlig rettighet, Foreslå apper, som er det som lar den tilby appen den nettopp bygde i stedet for at du må kopiere en URL for hånd. Den trenger også å kunne åpne sprettoppvinduer, fordi GitHubs og Cloudflares samtykkeskjermer kommer i ett slikt. Haven spør deg fortsatt før den installerer noe, hver eneste gang.

Byggeren er selv åpen kildekode, og den hostede kopien er en bekvemmelighet og ikke et krav. Vil du heller at Cursor-nøkkelen aldri passerer en server du ikke drifter selv, klon [`mindoodb-app-builder`](https://github.com/klehmann/mindoodb-app-builder) og kjør den selv; den serverer på en loopback-adresse, som teller som en sikker origin, så en Haven på HTTPS kan fortsatt bygge den inn. Pek Haven mot din egen kopi med Ny app → Fra URL i App Store, med loopback-adressen den skriver ut ved oppstart, i stedet for å installere katalogoppføringen. Det er den samme applikasjonen, og Cursor-nøkkelen forlater da aldri maskinen din.

## Synkronisering

Synkronisering er måten dataene i de lokale replikaene dine holder følge med serveren på. Alle kan synkronisere databasene de allerede har tilgang til — du trenger ikke å være administrator.

Skjermen lister opp hver sporede database i hver lokale replika den aktive brukeren kan se. Radene er gruppert etter tenant. For hver rad ser du hvilken server, tenant, replika og database den hører til, retningen på synkroniseringen (kun send, kun hent eller begge) og resultatet av siste synkronisering. Et lite «synkronisert før»-merke dukker opp på rader som har fullført minst én gang tidligere, noe som gjør det lett å få øye på databasene som aldri har blitt hentet ennå.

En tenant som bare finnes på denne enheten, har ingen rader å liste opp, fordi det ennå ikke finnes noen server å synkronisere mot. I stedet for å utelate den gir Synkronisering den et eget kort med en Overfør til server-knapp, som åpner den samme publiseringsdialogen som Innstillinger → Tenants. Dette er den vanlige måten å ta en tenant fra oppsettsveiviseren til en delt tenant på: kortet ligger der du ville lett etter synkronisering uansett, og det forsvinner så snart tenanten ligger på en server og databasene dens dukker opp som vanlige rader.

Det finnes tre måter å utløse synkronisering på. Synkroniser-knappen på en rad oppdaterer bare den databasen. Synkroniser tenant-knappen (på hver tenants overskrift) oppdaterer hver database i den tenanten. Synkroniser alle-knappen øverst på siden oppdaterer alt i ett jafs. Mens en synkronisering pågår, viser statuskolonnen fremdrift live, blant annet hvor mange batcher som er overført. En grønn hake betyr at raden ble ferdig uten feil. Et rødt merke betyr at noe gikk galt; når det skjer, lar Haven raden stå slik den var før synkroniseringen startet, så du ender aldri opp med halvveis anvendte endringer.

Synkroniser alle er en delt knapp, og nedtrekksmenyen inneholder ett valg det er verdt å finne: Send endringer automatisk til servere. Med den på sender Haven endringene dine oppover etter hvert som du gjør dem, i stedet for å vente på neste manuelle synkronisering, og det tar bort mesteparten av «husket jeg å synkronisere?» i en arbeidsdag. Den dekker bare den utgående halvdelen, og den huskes per brukeridentitet og ikke per enhet.

Den innkommende halvdelen trenger ingen innstilling, for den er alltid på. For hver server og tenant som har minst én rad satt til hent eller begge, holder Haven en levende changefeed åpen og lytter. Når serveren melder om en endring i en database du sporer, henter Haven den et par sekunder senere gjennom den vanlige synkroniseringsmotoren, så raden viser den samme fremdriften og den samme grønne haken som en synkronisering du startet selv. En melding tvinger ikke fram en overføring: Haven sammenligner heads først, så nyheter om noe du allerede har, koster én billig forespørsel. En feed som faller ut, kobler seg til igjen av seg selv. Det feeden derimot er avhengig av, er det synkronisering alltid er avhengig av — at Haven-fanen er åpen og den aktive identiteten er låst opp — og rader satt til kun send eller slått av holdes utenfor, siden ingenting ved dem venter på å komme ned. Over en vanlig servertilkobling kommer feeden som server-sent events; over en Iroh-tilkobling brukes en Iroh-strøm i stedet. En server som er for gammel til å tilby en changefeed, får rett og slett ingen, og radene dens blir stående på manuell synkronisering.

Med begge halvdelene på plass holder en servertilkobling seg oppdatert i begge retninger, og de manuelle Synkroniser-knappene blir det du griper til når du vil ha visshet i et bestemt øyeblikk, ikke det som flytter dataene dine.

En Stopp-knapp dukker opp mens en synkronisering pågår. Den sender et samarbeidende stoppsignal til den pågående kjøringen. Den gjeldende raden får lov til å bli ferdig eller rulle rent tilbake, så du ender ikke opp med halvskrevne data. Det er ett forbehold verdt å kjenne til: trykker du Stopp mens en bestemt rad er midt i en overføring, kan den raden ende opp med bare noe av de nye dataene, så neste lesing kan blande ferske og gamle verdier. Etter en stopp, kjør den raden på nytt før du stoler på tall fra den.

Når bør du synkronisere? Det korte svaret er: før du stoler på et tall du skal dele. Kjør synkronisering før du lager en eksport fra en virtuell visning, før du går inn i et møte basert på et dashbord, og når som helst nettet har vært nede en stund. Synkroniser alle er alltid trygt — den henter bare nye data og sender de køede endringene dine; den sletter aldri arbeid du ennå ikke har lagret.

En liten felle: hvis du ventet at en database skulle dukke opp i køen og den mangler, er den vanlige grunnen at brukeridentiteten som holder replikaen, ikke er låst opp ennå. Synkronisering trenger nøklene fra den lokale KeyBag-en, og KeyBag-en åpner seg først når den aktive identiteten er låst opp fra topplinjen.

### Node-til-node-synkronisering uten server

Synkronisering trenger ikke å gå gjennom en server i det hele tatt. To Haven-enheter i samme tenant kan utveksle data direkte, og det viser seg å bety noe i to ganske ulike situasjoner. Den åpenbare er et serverutfall: teamet fortsetter å jobbe og dataene fortsetter å bevege seg, fordi ingenting i veien er avhengig av at serveren er oppe. Den mer subtile er vanlig utkastarbeid. To personer som jobber seg gjennom det samme dokumentet, kan synkronisere rett til hverandre mens de går runder, og sende det ferdige resultatet til serveren én gang, i stedet for å rute hver mellomtilstand gjennom den.

Du starter det fra ⋮-menyen på en tenants overskrift på Synkroniseringssiden, under Node-til-node-synkronisering uten server. Dialogen som åpnes, heter Synkroniser med en annen enhet og lister opp enhetene i den tenanten — dine egne under Dine enheter, alle andres gruppert etter medlemmet de tilhører. Hver rad gir enhetens etikett, Endepunkt, Signeringsnøkkel og om den er Tilgjengelig akkurat nå. Velg en og trykk Legg til enhet.

Enheten i den andre enden må vente på deg. I Innstillinger → Generelt finnes et kort som heter Synkronisering mellom enheter med en avkrysningsboks: Godta innkommende enhetssynkronisering. Å slå den på lar andre enheter i denne tenanten synkronisere direkte med denne — også enheter som tilhører andre medlemmer, ikke bare dine egne. To betingelser følger med. Lytteren finnes bare mens Haven-fanen er åpen, og økten må være låst opp; en fane som står ved opplåsingsdialogen, svarer, men nekter å synkronisere, og det er nøyaktig det Haven melder tilbake til den andre siden når det skjer.

Det som gjør enheter mulige å finne, er en endepunkt-ID. Haven genererer én per enhet første gang den starter, og publiserer den i tenantens brukerkatalogdatabase, som også er der dialogen Synkroniser med en annen enhet henter listen sin fra — det er derfor den kan vise deg et lesbart brukernavn og en enhetsetikett i stedet for en naken identifikator. Publiseringen skjer enten du godtar innkommende synkronisering eller ikke, og det er bevisst: hele poenget er at enheter fortsatt kan finne hverandre når serveren er nede og ingenting nytt kan publiseres. Baksiden er at en enhet bare vet om noder den allerede har hentet katalogoppføringen til, så en tenant som aldri har vært synkronisert på denne enheten, har ingen å tilby ennå.

Under panseret kjører dette på Iroh-nettverket. I nettleseren når Haven den andre enheten gjennom et Iroh-relé — en konsekvens av hva en nettside har lov til å gjøre med nettverket, ikke et designvalg — mens en nativ Haven-bygging kan koble til direkte når begge enhetene ligger på samme nettverk. Den samme transporten er tilgjengelig mellom klient og server, hvis MindooDB-serveren er konfigurert til å bli med i Iroh; [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) dekker den siden av oppsettet.

Det klient-server-tilfellet er verdt et nærmere blikk, fordi det endrer hva en server må være. Nådd over HTTP må en server være tilgjengelig: et vertsnavn, et sertifikat og en port noe på internett har lov til å åpne. Over Iroh gjelder ingenting av dette. Serveren kan sitte inne i et nettverk ingenting kan ringe inn til — en maskin hjemme bak en NAT-ruter, uten videresendt port — og Haven når den likevel, fordi ingen av sidene må ta imot en innkommende tilkobling: de finner hverandre gjennom et relé, som enten hjelper dem med å åpne en direkte vei eller bærer trafikken selv når ruteren ikke tillater en. I stedet for en `https://`-adresse skriver du inn `iroh:`-lokatoren serveren skriver ut når den starter, og synkroniseringen går som den alltid gjør, levende changefeed inkludert. Et relé i veien ser ikke mer enn serveren gjør: det som passerer, er chiffertekst, og reléet lærer bare at to endepunkter snakker sammen.

Mens andre enheter synkroniserer med din, vokser det fram et panel på Synkroniseringssiden med overskriften Innkommende node-til-node-synkronisering og en telling av øktene, som lister opp hvilken enhet som overførte hva og i hvilken retning. Det tømmes ved omlasting, og det er stedet å se når du vil bekrefte at en direkte synkronisering virkelig fant sted.

## Hurtigskann

Hurtigskann er en dokumentskanner innebygd i Haven, og den gjør et papirark om til en ren fil uten at noe forlater nettleserfanen. Åpne den fra Start, og den dukker opp som et overlegg på arbeidsområdet i stedet for som en skjerm du må navigere deg ut av igjen.

Rett kameraet mot en side, eller velg et bilde du allerede har. Haven finner kantene på arket, retter opp perspektivet så resultatet ser ut som et skann og ikke som et fotografi tatt på skrå, og lar deg rette opp, beskjære og rotere etterpå. Velger den automatiske kantgjenkjenningen feil rektangel — en mønstret duk klarer det — dra hjørnene selv eller trykk Finn kanter på nytt for å prøve igjen. Sideforvalg som A4 og Letter holder utdataene i et fornuftig sideforhold.

Et skann trenger ikke å være ett enkelt ark. Trykk Legg til side og ta den neste, og fortsett til bunken er ferdig. En filmstripe langs kanten viser sidene du har så langt og nummererer dem; velg en for å rotere den, eller kast den og ta den siden på nytt. Et flersidig skann kommer ut som én PDF, mens én side også kan bli en PNG eller en JPEG. Det finnes også en Hent ut tekst-handling som kjører OCR over siden når du vil ha ordene i stedet for bildet.

Alt sammen skjer i nettleserfanen. Hurtigskann virker offline, ingenting lastes opp til en tjeneste for behandling, og bildet forlater aldri enheten annet enn gjennom nedlastingen eller delingen du selv velger.

Det Hurtigskann ikke gjør, er å arkivere resultatet for deg. Den har to veier ut — en nedlastingsknapp og systemets delingsark — og begge gir deg en fil; ingenting skrives inn i en database. Vil du at skannet skal havne inne i et dokument, start det fra det som eier dokumentet. Databaseutforskeren skanner rett inn på dokumentet du har åpent, og en applikasjon kan åpne den samme skanneren gjennom App SDK og feste resultatet til et av sine egne dokumenter. Det er den samme skanneren og den samme perspektivkorreksjonen alle tre stedene; bare det siste trinnet er forskjellig.

## Virtuelle visninger

Virtuelle visninger er den analytiske flaten i Haven. De gir deg et regnearklignende tre som filtrerer, kategoriserer, sorterer og summerer dokumenter på tvers av én database, flere databaser eller til og med flere tenanter. Det er slik du svarer på spørsmål på tvers av dataene dine i stedet for bare inne i én database.

De har en annen jobb som er lett å overse: en visning er en god datakilde for en applikasjon. Å gi en app en hel database er noen ganger mer enn den trenger og mer enn du vil gi fra deg. Bygg en visning som eksponerer nøyaktig de dokumentene og kolonnene appen skal jobbe med, knytt appen til visningen i stedet for databasen, og appen får det den trenger mens resten blir liggende utenfor rekkevidde.

Skjermen Virtuelle visninger har to deler: katalogen over lagrede visninger øverst og byggelerretet som åpnes under den når du velger eller oppretter en. Katalogen tilbyr Ny visning, Åpne visning, Rediger visning, Dupliser visning og Fjern visning, pluss Importer- og Eksporter-knapper for å flytte visningsdefinisjoner mellom miljøer. Hver rad viser visningens navn og datakildene den har.

Byggelerretet er der visningen faktisk settes sammen. Øverst gir du visningen et navn, en valgfri beskrivelse og en kategoriseringsstil (for eksempel kategorier før dokumenter). Under det kommer Kilder-delen, der hver kilde får en opprinnelsesetikett (så radene i resultatet kan fortelle deg hvilken database de kom fra) og kobles til en tenant og en database. Under Kilder kommer kolonnelisten, der du legger til kategorikolonner, sorteringskolonner og sumkolonner, enten med den visuelle byggeren for vanlige tilfeller eller med en liten bit kode i sandkasse for avanserte beregninger. En levende forhåndsvisning bygges om underveis, så du ser virkningen av hver endring med én gang.

Hver kilde kan lese fra en lokal replika eller fra en direkte ekstern kilde. Kilder fra lokal replika er de raskeste og virker offline; direkte kilder henter ferske data fra serveren før indeksering, noe som er tregere, men gir deg den nyeste tilstanden på serversiden. Én visning kan blande begge. Som standard bør du bruke lokale replikakilder og bare bytte enkelte til direkte når ferskhet betyr mer enn fart.

Fordi en visning kan spenne over millioner av rader, indekserer Haven den lokalt og inkrementelt. Hver lagret visning eier sin egen materialiserte indeks i denne nettleseren. Fra visningens overskrift kan du sette den pågående indekseringsjobben på pause ved neste rene sjekkpunkt, fortsette den der den slapp, eller bygge den på nytt fra bunnen. Pause og fortsett dekker nesten alle situasjoner; å bygge på nytt trengs bare etter at du har endret visningens kolonner eller kilder, fordi de endringene ugyldiggjør mellomlagringen. Å bygge på nytt ellers kaster bort arbeid mellomlagringen kunne gjenbrukt.

I resultattreet kan du utvide kategorier, bore ned i dokumenter og bruke avkrysningsboksene til å bygge et utvalg. Å velge en kategori velger implisitt hvert synlige dokument under den. Eksporter .xlsx lager en ekte .xlsx-arbeidsbok: den beholder de tilhørende kategoriradene over de valgte dokumentene og tar med både kildemetadata og eventuelle beregnede visningskolonner, så du kan gi filen rett videre til et verktøy utenfor MindooDB.

## Databaseutforsker og DAG-utforsker

Databaseutforskeren er for å grave i én enkelt database. Det er der du lister opp dokumenter, blar i historikk, sammenligner to revisjoner side om side og redigerer den levende. Det er den mest nyttige skjermen når du feilsøker data, sjekker hva som endret seg, eller henter et vedlegg ut av en bestemt revisjon.

Dokumentlisten har tre moduser: Alle, Eksisterende og Slettet. Filterfeltet godtar én ID, kommaseparerte ID-er eller én ID per linje, noe som er praktisk når du har en liste med ID-er fra en kollega eller et skript. Hver rad viser gjeldende revisjon pluss et lite merke for dokumenter som fortsatt har åpen historikk.

Klikker du på et dokument, utvides hele revisjonshistorikken, nyeste først. Historikken inkluderer den levende gjeldende revisjonen, hver tidligere revisjon og slettehendelsen der det finnes en. For store historikker lastes radene i batcher; å rulle inne i utvidelsespanelet henter mer.

En sammenligning side om side er et av utforskerens mest nyttige triks. Velg én historikkrad til ruten Venstre og en annen til ruten Høyre, så framhever Haven nøyaktig hvilke felter som endret seg. Utvalget deles på tvers av siden, så du kan sammenligne to revisjoner av det samme dokumentet, eller sammenligne to helt forskjellige dokumenter. Dette er den enkleste måten å bekrefte hva en automatisk endring faktisk gjorde på, før du fletter noe for hånd.

Redigering er bare tillatt på den levende gjeldende revisjonen. Historiske og slettede revisjoner er strengt skrivebeskyttet av design — Haven lar deg ikke overskrive historikk. Vedlegg kan derimot lastes ned fra hvilken som helst revisjon, også slettede, så du kan hente tilbake en fil som en gang var festet og siden fjernet.

Hver rute, hvert filter og hver sammenligning gjenspeiles i URL-en, så et bokmerke eller en delt lenke tar deg tilbake til den samme visningen.

Når den enkle revisjonslisten ikke er nok til å forklare hva som skjedde, åpne DAG-utforskeren. Den er en grafgjengivelse av hver signerte livssyklusoppføring som noen gang er brukt på dokumentet. Tiden går fra venstre mot høyre: hver node er én signert oppføring, og kantene viser hvordan oppføringene fulgte hverandre. Grener dukker opp når to personer redigerte dokumentet samtidig, og de møtes igjen i en flettenode når neste synkronisering brakte arbeidet deres sammen.

Hver node er merket med hvilken slags oppføring den representerer. Opprett markerer dokumentets aller første oppføring. Endre er en vanlig redigering som berørte felter eller vedlegg. Slett er en gravsteinsoppføring — den forrige kroppen bevares, bare livssyklustilstanden endres. Gjenopprett henter tilbake et slettet dokument og peker tilbake til Slett-oppføringen den omgjør. Snapshot-noder er periodiske komprimeringssnapshoter og er skrivebeskyttet her; du kan ikke klikke på dem for å materialisere en egen gren.

Å holde pekeren over en node viser hvem som gjorde endringen, når, fra hvilken enhet og hvilke felter som ble berørt. Klikker du på en node som ikke er et snapshot, materialiserer Haven dokumentet slik det stod på den grenen, og viser resultatet i panelet Materialisert tilstand, sammen med vedleggene som fantes på det tidspunktet. Haven gjenbruker enten et snapshot i nærheten eller spiller av oppføringskjeden fra grenrøttene, og den forteller deg hvilken av de to den gjorde. Et annet panel, Konfliktanalyse, lister opp konfliktstiene som er knyttet til oppføringen du valgte, fordi MindooDBs Automerge-motor løser samtidige redigeringer etter en deterministisk regel i stedet for å gjette.

Ingenting i DAG-utforskeren kan redigeres. Det er en tro, skrivebeskyttet gjengivelse av historikken. Det er også det som gjør den nyttig for etterlevelse: hver node er signert av brukeren som gjorde endringen, så den er fasiten når en revisor spør hvem som endret dette og når.

## Innstillinger

Innstillinger er den ene skjermen som er organisert som en fanerad i stedet for som én enkelt side. Den har seks faner: Generelt, Bruker-ID-er, Tenants, Backup, Gjenoppretting og Statistikk. Alt på disse fanene bor i denne nettleseren, med noen få bevisste unntak: handlingene i Tenants, den frivillige innstillingen Arbeidsflate som følger med, og endepunktet som Synkronisering mellom enheter publiserer slik at andre enheter kan finne denne.

### Generelt

Generelt er der du justerer hvordan Haven ser ut og hvordan den starter på enheten din. Alt sammen er personlig og trer i kraft med én gang — det finnes ingen Lagre-knapp.

Øverst setter Visningsspråk språket Haven selv snakker — navigasjonen, innstillingene, dialogene og hjelpen. Det rører ikke dokumentene dine, og applikasjoner som kjører inne i Haven, har med seg sine egne oversettelser.

Gjeldende tema lar deg velge et fargeforvalg (for eksempel Mindoo eller Aura) og bytte mellom lys og mørk modus. Forvalget endrer aksentfarger gjennom hele appen; lys/mørk-bryteren styrer bakgrunns- og tekstkontrasten. Det samme temavalget speiles i identitetsbrikkens høyreklikkmeny og sendes live videre til enhver innebygd MindooDB-app, så de matcher Havens utseende uten å måtte lastes på nytt.

Legg Haven til på Hjem-skjermen er et kort med ett trykk som tilbyr en snarvei til installasjonsveiledningen for plattformen din. På iPhone lenker det til Safaris Legg til på Hjem-skjerm-flyt; på Android utløser det nettleserens installasjonsdialog eller peker deg mot Installer app-handlingen i nettlesermenyen. Kjører Haven allerede fra sitt installerte ikon, bekrefter kortet bare det og viser en Se installasjonstrinnene-knapp i tilfelle du vil legge til enda en kopi.

En bryter som heter Optimaliser for iOS-multitasking forteller Haven at den brukes i delt skjerm eller slide over på iPad, der systemet legger på vinduskontroller som overlapper Havens egne. Slår du den på, flyttes Havens kontroller unna dem. Under Bevegelse fjerner Reduser animasjoner Havens overganger for alle som synes de forstyrrer, eller hvis system allerede ber om mindre bevegelse.

Synkronisering mellom enheter er der den mottakende halvdelen av node-til-node-synkronisering ligger. Avkrysningsboksen er Godta innkommende enhetssynkronisering, og kortet viser også endepunktet til denne enheten — identifikatoren andre enheter ringer for å nå den — sammen med om noen kan se den akkurat nå. Avsnittet om node-til-node-synkronisering under Synkronisering forklarer hva de to sidene gjør; dette er bryteren som gjør denne enheten til en av dem.

Arbeidsflate som følger med er den ene innstillingen på denne fanen som forlater nettleseren, og den er av til du slår den på. Den lar arbeidsområdesidene, flisene, gruppene og applikasjonslisten til den aktive bruker-ID-en følge deg til de andre enhetene dine, og den lar deg ha flere miljøer og bytte mellom dem — kontor og hjem, eller desktop og mobil. Det er en Haven Enterprise-funksjon: uten en aktiv lisens blir bryteren stående av, denne enheten verken lagrer arbeidsflaten sin eller overtar en, og miljøer du satte opp tidligere, blir liggende nøyaktig som de er til en lisens importeres igjen. Å slå bryteren på avdekker to felter: tenanten arbeidsflaten synkroniseres gjennom, og navnet på den lagrede arbeidsflaten. Navnet er måten enhetene finner hverandre på, så «kontor» på laptopen din og «kontor» på telefonen din deler én arbeidsflate; feltet åpner en nedtrekksliste over navnene som allerede er lagret for denne bruker-ID-en, og skriver du et navn som ikke står i listen, starter du en ny. Ingen av feltene trer i kraft mens du redigerer det — Bruk bekrefter begge, Avbryt setter tilbake det som gjelder. Hva Bruk gjør, følger av navnet: et nytt opprettes fra denne enhetens arbeidsflate, et eksisterende overtas, og fanene og flisene som er ordnet her, erstattes av det. Den erstatningen koster deg bare noe når funksjonen var av, så det er det ene tilfellet Haven spør om først; når den først er på, ligger denne enhetens tilstand allerede i den lagrede arbeidsflaten, og å flytte til et annet navn er gratis. Å slå bryteren av stopper det med én gang og lar hver lagret arbeidsflate være urørt.

Det som følger med, er bare organiseringen: sider og rekkefølgen deres, hver flis med posisjon og størrelse, grupper, rutenett- og sorteringsinnstillingene, og applikasjonsregistreringene dine. Det som blir liggende lokalt, er bevisst holdt utenfor — hvilken side du ser på akkurat nå, slik at en annen enhet ikke kan rykke i blikket ditt. Apper som tenant-administratoren din distribuerer med en policy, holdes også utenfor, fordi hver enhet allerede får dem fra tenant-katalogen.

Den lagrede arbeidsflaten er et helt vanlig MindooDB-dokument i tenantens brukerkatalog, kryptert for deg alene — kolleger og administratorer synkroniserer bytene dens som alt annet og kan ikke lese et ord av det, og bare dine egne enheter kan endre eller slette den. Fordi den er et dokument, reiser den nøyaktig som dataene dine gjør: en endring skrives lokalt og når den andre enheten ved neste synkronisering, så begge enhetene må kunne nå serveren, ikke hverandre, og ingen av dem må være åpen samtidig. To enheter som redigerer samtidig, fletter i stedet for å overskrive — å flytte en flis her mens du gir en side nytt navn der, beholder begge endringene, og den samme flisen dratt på begge enhetene lander på én posisjon. Du kan ha flere lagrede arbeidsflater per bruker-ID, følge én av dem per enhet, og slette en for godt fra det samme kortet; enheter som fulgte den, slutter rett og slett å følge med og beholder oppsettet de har. Listen blir stående synlig med funksjonen slått av og dekker hver tenant denne bruker-ID-en når, så hver oppføring navngir tenanten sin ved siden av navnet på den lagrede arbeidsflaten, og når den sist ble skrevet av den av enhetene dine som skrev den — en arbeidsflate ingen har rørt på månedsvis, er lett å få øye på før du sletter den.

### Bruker-ID-er

En brukeridentitet er kontoen din inne i Haven, og denne fanen er der du håndterer de lagrede identitetene dine. Hver rad er én identitet med brukernavnet sitt, hva den låses opp med, og opprettelsesdatoen sin; admin-identiteter er merket med en Administrator-etikett så de er lette å skille fra vanlige brukere. Handlingen Bytt til bruker gjør den identiteten til den aktive for denne Haven-økten — for en passnøkkelidentitet er det én enkelt knapp og en Face ID-forespørsel i stedet for et inntastet passord. Bare én identitet er låst opp om gangen; klager noe på en annen skjerm over at det ikke kan lese en tenant, er det som regel feil identitet som er låst opp.

Opprett bruker-ID lager en helt ny identitet direkte i nettleseren og tilbyr det samme valget mellom passnøkkel og passord som velkomstveiviseren. Importer bruker-ID henter inn en .json-fil som tidligere er eksportert fra Haven eller laget av MindooDB-konsollet (for eksempel på en annen enhet eller av en kollega), og spør om passordet som ble brukt da filen ble eksportert.

Kolonnen Låses opp med forteller deg hvilke hemmeligheter som åpner en identitet i dag, og én knapp endrer det: Innloggingsalternativer. Den gjentar hva som åpner den valgte identiteten i dag, og tilbyr så bare de endringene som passer den: en identitet som allerede har et passord, får ikke tilbud om et til, og en identitet uten passnøkkel har ingen å fjerne, så listen blir to eller tre oppføringer i stedet for en vegg av nedtonede knapper. Unntaket er en handling som passer identiteten, men som en regel forbyr — den blir stående i listen med begrunnelsen skrevet i stedet for beskrivelsen, fordi begrunnelsen som regel er veien videre. En administratoridentitet sier hvorfor den blir stående med bare passord, og Fjern passordet på en identitet som ennå ikke har en passnøkkel, sier at du må legge til en først i stedet for bare å nekte.

Legg til en passnøkkel registrerer denne enhetens autentikator for en identitet som bare hadde et passord; passordet ditt fortsetter å virke akkurat som før, så dette er en trygg ting å gjøre på hver enhet du bruker. Fjern passnøkler fjerner de registrerte autentikatorene igjen. Legg til et passord gjør det motsatte, og betyr mest for eksport: konsollet og SDK-en kjører i Node, der det ikke finnes noen autentikator å spørre, så en identitet med bare passnøkkel kan ikke åpnes utenfor denne nettleseren. Ber du om en full eksport av en identitet med bare passnøkkel, toner ikke Haven ned menyvalget — den ber om et passord først, legger det til ved siden av passnøkkelen, og skriver så filen. Ingenting krypteres på nytt i prosessen; identiteten får rett og slett en vei inn til.

Fjern passordet er valget du bør tenke deg om to ganger på. Det etterlater en identitet som bare passnøkkelen åpner, noe som er det sterkere oppsettet — det finnes ingen inntastet hemmelighet igjen å fiske etter, gjenbruke eller glemme — men det snevrer også veiene tilbake inn ned til én. Haven nekter blankt med mindre en passnøkkel er registrert, fordi en identitet uten noen opplåsingsmetode igjen ikke kan gjenopprettes: nøkkelen som åpner de private nøklene, finnes bare inne i de innpakningene. Selv med en passnøkkel på plass, ha en kryptert backup: en passnøkkel som ikke synkroniseres, bor i denne ene autentikatoren, og backup-filen er det som gjør en mistet laptop til «gjenopprett og skriv backup-passordet» i stedet for en mistet identitet. Full identitetseksport blir stående blokkert så lenge det ikke finnes noe passord, av Node-grunnen over, og å legge et tilbake er en dialog med to felter unna.

Endre passord ligger i den samme listen. For en identitet der opplåsingsmetodene er innpakninger rundt en intern nøkkel — alt som er opprettet nylig, og alt som noen gang har hatt en passnøkkel — bytter Haven bare ut passordinnpakningen, så hver registrerte passnøkkel forblir gyldig og ingen KeyBag må bygges på nytt. For en eldre identitet der passordet krypterer de private nøklene direkte, krypterer Haven disse og tenant-KeyBagene som avhenger av dem, på nytt i ett steg, så det nye passordet virker overalt med én gang. Uansett, velg et sterkt passord og lagre det et sted du finner igjen, for det finnes ingen lenke for å nullstille: glemmer du det nye passordet, blir hver tenant knyttet til denne identiteten uleselig, også på enheter som allerede hadde dataene. Lagre det i en passordbehandler før du trykker Lagre.

Ble en identitet opprettet med et passord før passnøkler fantes, tilbyr Haven å legge til en neste gang du låser den opp. Å takke ja tar én Face ID-forespørsel og lar passordet bli stående som reserve. Å velge Fortsett med passordet er et permanent svar for denne enheten: Haven husker det og spør aldri igjen for den identiteten, og Innloggingsalternativer på denne fanen er fortsatt tilgjengelig hvis du ombestemmer deg senere. Å lukke dialogen med X eller Escape utsetter bare spørsmålet, så du kan bestemme deg ved neste opplåsing. Å fjerne en passnøkkel igjen teller også som et svar — Haven begynner ikke å tilby en ved hver opplåsing etterpå.

Under identitetstabellen, når en identitet først er låst opp, lister Dine enheter opp hver enhet som har — eller venter på å få — den personens brukernøkkel, én rad per enhet og tenant, med en Godkjenn- eller Tillat likevel-handling der du har lov til å bruke den. Dette er panelet bak godkjenningsflyten som beskrives under Bruke Haven på mer enn én enhet, og stedet å gå til når du lukket godkjenningsdialogen for raskt.

### Tenants

En tenant er teamets private arbeidsområde, og denne fanen lister opp hver tenant Haven kjenner til for den aktive brukeridentiteten. For hver rad ser du tenant-ID-en, gjeldende bruker, admin-brukeren og eventuelle servere tenanten er publisert til.

Å åpne en tenant viser nøkkelfingeravtrykkene dens og hvor den er publisert nå. Fingeravtrykkene kommer fra den lokale KeyBag-en for den aktive brukeren, så de dukker først opp når den brukeren er låst opp. Behandle fingeravtrykk som identitetsbevis for tenantens krypteringsnøkler: sammenligner to teammedlemmer dem ansikt til ansikt og de stemmer, kan du være trygg på at ingen byttet en nøkkel underveis.

Handlinger som berører tenant-katalogen — å publisere en tenant, eller å gi en kollega tilgang ut fra en innmeldingsforespørsel — signeres av admin-identiteten, så Haven ber om passfrasen dens. Fordi de oppgavene som regel kommer i bunker, tilbyr forespørselen å låse opp administratoren for denne økten: kryss av én gang, så slutter trinnene etterpå å spørre. Å låse opp en administrator på denne måten bytter ikke den aktive identiteten din, så den daglige brukeren din er fortsatt den som gjør dokumentarbeidet, og handlingen Lås administratoren igjen avslutter det tidlig når du er ferdig.

Nye tenanter starter alltid i denne nettleseren for den aktive brukeren. Å publisere sender tenanten til en MindooDB-server slik at andre teammedlemmer kan bli med; Synkroniseringssiden tilbyr det samme steget som en Overfør til server-knapp mens en tenant fortsatt bare er lokal, så de fleste møter det først der. Å slette fra en server fjerner tenant-plasseringen fra bare den serveren — den lokale kopien blir liggende. Å publisere og å slette på en server krever et systemadministratorpassord, fordi det berører delt infrastruktur; er du ikke plattformadministratoren, be dem kjøre handlingen sammen med deg.

Vær forsiktig med sletting på server. Det visker ut den serverens bilde av tenanten for hver bruker, ikke bare ditt, og andre klienter kan plutselig feile i synkroniseringen. Bekreft det med plattformadministratoren og eventuelle andre teamadministratorer først, og sørg for at det finnes en fersk kryptert backup før du trykker på knappen.

### Backup

Haven holder nesten alt i denne nettleseren. Backup-fanen er sikkerhetsnettet, og den tilbyr to svært forskjellige nett: en kryptert fil som rommer alt, og en papirutskrift som kan hente én enkelt tenant tilbake fra ingenting. Å legge en av dem tilbake — og å tømme Haven — skjer på Gjenoppretting-fanen ved siden av.

En kryptert backup er én enkelt fil som inneholder alt Haven holder i denne nettleseren: lagrede brukere, tenanter, applikasjoner, hostede appfiler, arbeidsområdeoppsett, virtuelle visninger og det lokale IndexedDB-innholdet. Du velger et backup-passord, og Haven bruker det til å kryptere filen før den lastes ned. Det finnes nøyaktig ett backup-passord for hele filen, uansett hvor mange identiteter som ligger inni den. Selve passordet lagres aldri noe sted — Haven kan ikke vise det til deg senere og kan ikke hjelpe deg med å gjenopprette backupen hvis du mister det. Nedlastinger bruker filendelsen .mdbhaven-backup, så de er lette å få øye på i en nedlastingsmappe.

Identiteter som låses opp med en passnøkkel, krever én ekstra vurdering, fordi en passnøkkel ikke kan forlate enheten som har den — det er hele poenget med en passnøkkel, og det er også derfor gjenoppretting på en ny laptop ellers ville gitt deg en identitet ingen kan åpne. Haven løser dette inne i filen i stedet for ved å svekke enheten din: for hver identitet med bare passnøkkel legger den til en kopi av opplåsingsnøkkelen som åpnes med backup-passordet ditt. Den lokale identiteten din er urørt og beholder passnøkkelen sin. Er noen av de identitetene låst akkurat nå, ber Haven om passnøkkelen én gang mens nedlastingen klargjøres. Den praktiske konsekvensen er at backup-passordet er like verdifullt som identitetene i filen: behandle det som en hovednøkkel og oppbevar det deretter.

Det andre kortet på fanen er tenant-nødutskriften, og den svarer på et annet spørsmål: hva overlever når ingen nettleser gjør det. Den dekker én tenant om gangen og inneholder bare det som ikke kan lastes ned på nytt — bruker- og admin-identitetene du velger, KeyBag-nøklene deres, server-URL-en og synkroniseringsoppsettet — slik at en senere synkronisering kan hente selve dokumentene fra serveren. Den inneholder bevisst ingen dokumentdata, noe som også betyr at den er til ingen nytte for en tenant som aldri ble publisert. Du velger et hemmelig spørsmål, som skrives ut på arket, og et svar, som ikke skrives ut; svaret er det som dekrypterer arket senere. Haven sprer så den krypterte nyttelasten over åtte QR-koder med nok redundans til at hvilke som helst seks av dem holder, så en kaffeflekk eller et avrevet hjørne ikke koster deg tenanten. Oppbevar det der du oppbevarer pass, ikke der du oppbevarer utskrifter.

### Gjenoppretting

Gjenoppretting-fanen er der en backup kommer tilbake, og der Haven kan tømmes når ingenting annet hjelper.

Å gjenopprette en kryptert backup-fil skjer i to steg, begge bevisste. Det første steget, Forhåndsvis gjenoppretting, dekrypterer filen akkurat nok til å vise deg et sammendrag av hva som ligger i den: antall identiteter, tenanter, applikasjoner, IndexedDB-databaser og eventuelle gjenopprettingsadvarsler. Ingenting lokalt røres ennå. Noen backuper inneholder databaser som ikke kan flyttes mellom nettlesere som de er; forhåndsvisningen viser en advarsel per berørt database med om den blir bygget opp tom igjen eller hoppet over. Bygg på nytt betyr at databasen opprettes tom og fylles på nytt fra synkronisering. Hopp over betyr at den ikke gjenopprettes i det hele tatt, og at du må koble til den kilden manuelt.

Det andre steget, Gjenopprett og last på nytt, tømmer Havens gjeldende tilstand i denne nettleseren og skriver backupen tilbake. Haven laster automatisk på nytt, og du ender opp innlogget i de gjenopprettede dataene. Fordi gjenoppretting sletter den gjeldende tilstanden først, er alt som ikke ble eksportert og ikke ble synkronisert, borte. Eksporter en fersk kryptert backup av den gjeldende tilstanden før du trykker Gjenopprett, for sikkerhets skyld.

Etter en gjenoppretting på en annen enhet eller nettleser vil identiteter som pleide å låses opp med en passnøkkel, be om backup-passordet i stedet, og opplåsingsdialogen sier fra om det. Passnøkkelen ble igjen på den gamle enheten, så dette er forventet og ikke et tegn på at noe gikk galt. Lås opp identiteten én gang med backup-passordet, og bruk så Legg til en passnøkkel for å registrere den nye enhetens autentikator; fra det punktet oppfører identiteten seg akkurat som før.

Å gjenopprette fra en tenant-nødutskrift bruker det andre kortet og den samme tosteg-forsiktigheten. Skann QR-kodene med enhetens kamera eller lim inn innholdet deres, svar på det hemmelige spørsmålet, og Haven legger identitetene, KeyBag-materialet, server-URL-en og synkroniseringsoppsettet tilbake. Ingenting annet reiser på papir, så kjør en synkronisering etterpå for å hente tenantens dokumenter ned igjen. Dette er også veien tilbake når hver godkjente enhet for en tenant er borte og det ikke er noen igjen til å godkjenne en ny.

Fabrikktilbakestilling ligger nederst på fanen. Den tømmer alt Haven kjenner til i denne nettleseren — identiteter, tenanter, applikasjoner, hostede appfiler, virtuelle visninger, arbeidsområdeoppsett og alle synkroniserte MindooDB-data — og setter Haven tilbake til den helt nye tilstanden sin. Fordi det ikke kan angres, ber Haven deg skrive en bekreftelsesfrase før knappen blir aktiv, og spør så nettleseren om enda en bekreftelse. Behandle fabrikktilbakestilling som en siste utvei, og bare etter at en kjent god backup finnes.

### Statistikk

Statistikk-fanen viser hvor mye plass Haven bruker inne i denne nettleseren, og lar deg frigjøre plass på en trygg måte. Nettlesere setter et tak for hvor mye lagring ett enkelt nettsted kan bruke, så det å forstå hva som tar plass, holder Haven rask.

Et stort tall øverst summerer alt Haven holder i denne nettleseren akkurat nå: hver lokale database, hver cache, hver hostede appfil. En Oppdater-knapp regner ut på nytt etter store operasjoner som en synkronisering, en sletting eller en cachetømming. Tallene oppdateres ikke av seg selv, fordi det kan gå tregt å måle store lagre. Knappen ved siden av, Frigjør ufullstendige opplastinger, rydder bort de krypterte blokkene som er igjen etter vedleggsopplastinger som aldri ble fullført; vedlegg som kom inn i dokumenthistorikken, røres aldri.

Under totalen viser en del per tenant én blokk per tenant. Hver tenant-overskrift har den samlede størrelsen sin pluss en Tøm cache-knapp som bare fjerner de delene som kan bygges opp igjen — cacher og indekser som Haven fyller på nytt neste gang du bruker tenanten. Tøm cache sletter ikke dokumenter eller vedlegg.

Inne i hver tenant er hver rad én lokal database. Dokumenter er det krypterte dokumentinnholdet, Vedlegg er krypterte vedleggsbiter, og Totalt er summen av de to. Slett visker ut den databasens lokale innhold i bare denne nettleseren — serverkopien røres ikke. Den beskyttede katalogdatabasen kan ikke slettes, fordi Haven trenger den for å virke. Før du sletter, åpne databasen og kjør Synkroniser; finnes det usynkroniserte lokale endringer, mister du dem ved sletting. Foretrekk Tøm cache når du bare vil frigjøre plass, fordi det kan gjøres om.

Under databasene i hver tenant ser du også cachene dens: en lokal tenant-cache for generell tilstand per tenant, en servermål-cache for hver MindooDB-server tenanten snakker med, en cache for virtuell visning for hver lagrede visning, og en oppføring Fulltekstindeks (MiniSearch) for hver database som har fulltekstindeksering slått på. Hver cache viser sin egen størrelse, og cacher for virtuelle visninger kan tømmes enkeltvis hvis én bestemt visning har vokst seg for stor.

En blokk med Globale cacher nederst dekker delte Haven-cacher som bor utenfor én enkelt tenant, for eksempel service worker-cachene for hostede apper. Disse har den samme størrelsesavlesningen som cacher på tenant-nivå.

## Installer Haven på en telefon

Haven er en progressiv webapp, som betyr at hver moderne mobilnettleser kan installere den som om den var en nativ app. Når den først er installert, åpnes den i frittstående modus, uten nettleserens adresselinje eller fanerad, noe som er renere og gir deg mer skjermplass.

På iPhone og iPad, åpne Haven i Safari og trykk Del-knappen — ikonet som ser ut som et kvadrat med en pil som peker opp. Rull i delingsarket til du ser Legg til på Hjem-skjerm, og trykk på det. iOS har allerede Havens ikon og navn, så det fyller inn de feltene for deg. Bekreft navnet og trykk Legg til, og et Haven-ikon dukker opp på Hjem-skjermen din.

iOS har en fin bonus: du kan legge Haven til på Hjem-skjermen mer enn én gang. Hver installerte kopi får sitt eget private lager på enheten, så dataene inne i én kopi er helt adskilt fra de andre. Dette er en flott måte å holde forskjellige verdener fra hverandre på den samme iPhone-en — én kopi for private notater, én for jobb, én for demoer — uten noen gang å logge inn og ut. Før du trykker Legg til andre gang, endre det foreslåtte navnet (for eksempel til Haven - Jobb) så ikonene på Hjem-skjermen er lette å skille fra hverandre. Hver kopi starter tom og trenger sin egen brukeridentitet, sine egne tenanter og sine egne synkroniserte databaser. Merk at krypterte backuper også er per kopi: gjenopprett en backup inne i den samme kopien du eksporterte den fra, ellers overskriver du et annet miljø.

På Android, åpne Haven i en moderne nettleser som Chrome eller Edge. Viser Haven en Installer-knapp, godta den, så legger nettleseren Haven til på Hjem-skjermen og i appskuffen i ett steg. Kommer det ingen forespørsel, åpne nettlesermenyen (som regel tre prikker i hjørnet) og se etter Installer app eller Legg til på Hjem-skjerm — ulike nettlesere ordlegger seg forskjellig, men resultatet er det samme. Bekreft nettleserens dialog, og Haven dukker opp på Hjem-skjermen som et helt vanlig Android-appikon.

Etter installasjon, start alltid Haven fra ikonet på Hjem-skjermen når du er på telefon — det er en merkbart hyggeligere opplevelse enn en nettleserfane.

## Sikkerhetsmodellen i korte trekk

Vil du forklare Haven for noen på ett minutt, er dette sammendraget.

Hver bruker har en kryptografisk identitet satt sammen av en Ed25519-signeringsnøkkel og en RSA-OAEP-krypteringsnøkkel. Begge de private nøklene er kryptert med en hemmelighet bare du har, lagret lokalt i nettleseren og aldri overført. Den identiteten er det som låser opp tenanter og signerer endringene dine.

Hemmeligheten kan være et passord eller en passnøkkel, og begge ender på det samme stedet. Haven gir hver identitet én intern tilfeldig nøkkel som krypterer de private nøklene, og pakker så den nøkkelen inn én gang per opplåsingsmetode: en passordinnpakning utledet med PBKDF2, og en passnøkkelinnpakning utledet fra WebAuthn PRF-utvidelsen. Å legge til eller fjerne en opplåsingsmetode legger bare til eller fjerner en innpakning, og det er derfor du kan ha begge samtidig, og derfor ingen av dem noen gang får vite den andres hemmelighet. Den samme mekanismen er det som får en YubiKey til å virke: for WebAuthn er en sikkerhetsnøkkel og en innebygd Face ID-sensor den samme typen autentikator, så Haven utelukker ikke roaming-nøkler — velg en YubiKey hvis du vil at opplåsingshemmeligheten skal bo på noe du kan legge i en skuff, i stedet for på selve laptopen. Det som ikke finnes, er en skykopi: ingenting deponeres hos MindooDB, hos Apple eller hos nettleserleverandøren din, og en passnøkkel synkroniseres ikke inn i en iCloud- eller Google-enhetsbackup i en form Haven kunne gjenopprette. Det er den bevisste avveiningen — ingen server kan tvinges til å låse opp dataene dine, og ingen server kan hjelpe deg hvis du mister hver hemmelighet du hadde. Den krypterte backup-filen din er gjenopprettingshistorien, og det er derfor Backup-fanen ikke er valgfri.

Hver tenant har en KeyBag — et kryptert lager for krypteringsnøkler, åpnet av identiteten som eier det. Standardnøkkelen deles med hvert medlem av tenanten og krypterer dokumenter med mindre en mer spesifikk nøkkel velges. Navngitte nøkler gir finkornet tilgang til en mindre gruppe for særlig følsomme dokumenter. Alt dette bor på enheten din; serveren ser aldri nøkler.

Hvert dokument er en Automerge CRDT lagret i et innholdsadressert lager. Hver endring signeres med Ed25519-nøkkelen din og krypteres med AES-256-GCM før den i det hele tatt forlater nettleseren. Serveren lagrer og videresender chiffertekst og kan aldri lese dataene dine, selv om den er fullstendig kompromittert. Transporten legger på et andre lag med RSA-OAEP-kryptering per bruker, og TLS pakker det hele inn som et tredje lag. Tilgangskontroll håndheves gjennom kryptering, som betyr at hvis du ikke har nøkkelen, er dokumentet bare chiffertekst — det finnes ingen betrodd server å spørre om tillatelse og lure til å gi den.

Fordi hver endring er signert og lagt til i en kjede, kan ikke historikk omskrives i det stille. Havens DAG-utforsker er en direkte gjengivelse av den kjeden, og Automerge fletter samtidige redigeringer deterministisk, så to personer kan jobbe på det samme dokumentet uten noen konfliktdialog.

Apper som kjører inne i Haven, er pakket inn i nettleserens sandkasse på sin egen origin. Hostede apper får en enda strengere sandkasse med ugjennomsiktig origin. En app kan ikke nå Havens lagring, informasjonskapsler eller andre apper; den ser bare databasene du knyttet til og rettighetene du ga. Hvert kall appen gjør — lesing, skriving, vedlegg, historikk — går gjennom Havens SDK-bridge, som validerer det mot tilknytningen før det berører noen data. Hostede apper kan heller ikke kontakte internett med mindre du førte opp URL-en; standarden er å nekte. Hele modellen, gjenværende risikoer og forskjellen fra apper lagret inne i en MindooDB-database finnes i [hosted-app isolation](hosted-app-isolation.md).

Det er, på et minutt, hvorfor Haven er privat av design og ikke av policy.

## Ordliste

Dette er begrepene Haven bruker på tvers av skjermene sine og i hjelpepanelet. De er listet omtrent i den rekkefølgen du sannsynligvis møter dem i, ikke strengt alfabetisk, fordi de fleste av dem bygger på dem foran.

Brukeridentitet — kontoen din inne i Haven. Opprettes lokalt, beskyttes av en passnøkkel eller et passord, og er det som låser opp tenanter og signerer endringene dine. Innstillinger-fanen kaller det Bruker-ID-er.

Passnøkkel — en opplåsingsmetode som støtter seg på enhetens autentikator: Face ID, Touch ID, Windows Hello eller en sikkerhetsnøkkel som en YubiKey. Haven utleder nøkkelen som åpner de private nøklene dine, fra den lokalt, så hemmeligheten forlater aldri enheten og sendes aldri til en server.

Passfrase — flere tilfeldige ord brukt i stedet for et passord. Haven tilbyr en generert passfrase på seks ord for admin-identiteter, fordi den både er sterkere enn et typisk inntastet passord og lett å skrive ned; å taste inn ditt eget passord i stedet er fortsatt mulig.

Tenant — teamets private arbeidsområde inne i MindooDB. Grupperer brukere, krypteringsnøkler og databaser sammen slik at et team kan dele data trygt.

Tenant-etikett — det lesbare navnet på en tenant. Haven genererer selve tenant-ID-en og den endres aldri; etiketten er den delen du velger, og en administrator kan gi den nytt navn når den slutter å passe.

Tenant-administrator — en privilegert identitet inne i en tenant. Kan registrere eller trekke tilbake andre brukere og endre innstillinger som gjelder hele tenanten.

App-bruker — en vanlig brukeridentitet inne i en tenant. Gjør det daglige dokumentarbeidet, men kan ikke registrere eller trekke tilbake andre brukere.

Systemadministrator — en identitet på servernivå som brukes til å administrere selve MindooDB-serveren: å koble Haven til den, å stole på andre servere, og å sette opp nye tenanter.

KeyBag — et lokalt, kryptert nøkkellager som holder krypteringsnøklene en tenant trenger, åpnet av identiteten som eier det. Hver bruker har sitt eget i denne nettleseren.

Standardnøkkel — krypteringsnøkkelen som deles med hvert medlem av en tenant. Angir ikke et dokument en navngitt nøkkel, krypteres det med standardnøkkelen.

Navngitt nøkkel — en ekstra krypteringsnøkkel som bare deles med utvalgte brukere. Nyttig for følsomme dokumenter som ikke bør være synlige for hele tenanten.

Brukernøkkel — et krypteringsnøkkelpar som tilhører en person og ikke en enhet eller en tenant. Den offentlige halvdelen publiseres i tenanten så andre kan kryptere til deg (det er slik standardnøkkelen når deg); den private halvdelen bor bare på enhetene du har godkjent. Én brukernøkkel per person, én innpakket kopi per godkjent enhet.

Enhetsgodkjenning — steget som lar en ny nettleser eller telefon lese en tenants dokumenter. En allerede godkjent enhet skriver en kopi av brukernøkkelen din for den nye; til det skjer, kan den nye enheten synkronisere chiffertekst, men ikke åpne den. Godkjenningen må alltid komme fra en enhet som allerede er godkjent.

Tenant-nødutskrift — et utskrivbart ark med redundante QR-koder for én tenant, som holder identiteter, KeyBag-nøkler og server- og synkroniseringsoppsettet, men ingen dokumenter. Lages på Backup-fanen, gjenopprettes på Gjenoppretting-fanen, og er den eneste veien tilbake når hver godkjent enhet er borte.

Signert endring — hver redigering av et dokument signeres med forfatterens private nøkkel. Det beviser hvem som gjorde endringen, og hindrer noen i å forfalske historikk senere.

Lokal replika — en nettleserlokal, synkronisert kopi av en tenants databaser. Rask, virker offline, og er den anbefalte måten å bla og redigere på.

Direkte kilde — en kildemodus som henter ferske data fra en MindooDB-server før de tas i bruk. Tregere enn den lokale replikaen, men nyttig når du trenger den aller nyeste tilstanden.

Changefeed — strømmen en server bruker til å melde fra om nye skrivinger til klientene som lytter på den. Haven holder én åpen per server og tenant den henter fra, og det er det som gjør at innkommende arbeid ankommer av seg selv. Alltid på; ingen egen innstilling.

Node-til-node-synkronisering — en direkte synkronisering mellom to enheter i samme tenant uten noen server i veien. Kjører over Iroh-nettverket. Den mottakende enheten må ha Godta innkommende enhetssynkronisering slått på, og fanen sin åpen og låst opp.

Endepunkt — adressen en enhet ringes på for node-til-node-synkronisering. Haven genererer ett per enhet og publiserer det i tenantens brukerkatalog, så enheter kan finne hverandre selv om serveren er utilgjengelig.

Iroh — nettverket Haven bruker når det ikke finnes noen tilgjengelig adresse å koble til. Det bærer node-til-node-synkronisering mellom to enheter, og det kan også bære vanlig klient-server-synkronisering til en MindooDB-server som har blitt med i det — en bak en NAT-ruter, for eksempel, uten videresendt port og uten sertifikat. Begge ender møtes gjennom et relé, som ser at de snakker sammen, men ikke hva de sier.

Hurtigskann — Havens innebygde dokumentskanner. Finner kantene på en side, retter opp perspektivet, og tar så mange sider du trenger, inn i ett skann. Kjører helt og holdent i nettleserfanen, offline inkludert. Den gir resultatet ut som en fil — en flersidig PDF, eller en PNG eller JPEG for én side — gjennom en nedlasting eller systemets delingsark; å feste et skann til et dokument gjøres fra Databaseutforskeren eller av en app gjennom App SDK.

IndexedDB — nettleserens innebygde database. Haven lagrer nesten alt inne i IndexedDB så den kan virke offline.

Nyttelast-byte — et omtrentlig mål på hvor mye reelt innhold Haven holder i denne nettleseren. Det utelater overheaden nettleseren selv legger på.

Lokal tenant-cache — en nettlesercache per tenant som hjelper Haven med å åpne arbeid raskere igjen, gjenoppta synkronisering og gjenbruke lokale spørringsdata. Kan tømmes og bygges opp igjen automatisk.

Servermål-cache — en cache avgrenset til én tenant og én server. Gjør direkte synkronisering mot den serveren raskere og kan tømmes trygt.

Cache for virtuell visning — lagrer en virtuell visnings materialiserte resultater pluss dens gjenopptagbare indekseringstilstand, så visningen åpnes raskt igjen. Å tømme den bygger visningen på nytt neste gang du åpner den.

Beskyttet database — en database Haven trenger for å virke (for eksempel tenant-katalogen). Den kan ikke slettes fra lagringspanelet.

Start — den faste første fanen i Arbeidsområdet. Bærer Havens seks snarveisfliser og én flis per installerte applikasjon. Den kan ikke omorganiseres; dine egne fliser hører hjemme på sidene ved siden av.

Flis — et kort på arbeidsområderutenettet som kan dras og endre størrelse. Hver flis holder en database, en applikasjon, et notat, en innebygd nettside, en video eller et diagram. Kalles også chicklet.

Side — en arbeidsområdefane som inneholder sitt eget rutenett av fliser. Bruk flere sider som hjemskjermer på en smarttelefon.

Gruppe — en visuell beholder som samler beslektede fliser under en delt, fargekodet overskrift. Dra en flis oppå en annen for å lage en gruppe.

Appskuff — panelet bak pilhåndtaket øverst i innholdsområdet. Lister opp Haven-skjermene du har åpne og applikasjonene som kjører nå, med en vei tilbake til Arbeidsområdet over begge. Cmd+Shift+Space åpner den og Cmd+Shift+Enter går tilbake til Arbeidsområdet; trykk Ctrl i stedet for Cmd på Windows og Linux.

Database — en samling beslektede dokumenter inne i en tenant. En tenant kan ha mange databaser (for eksempel kontakter, fakturaer, notater).

Katalogdatabase — en spesiell, beskyttet database i hver tenant som lagrer brukerregistreringer og innstillinger for hele tenanten.

Dokument — et enkelt dataelement inne i en database. Kryptert på denne enheten før synkronisering, så serveren ser aldri annet enn chiffertekst.

Revisjon — en versjon av et dokument på et gitt tidspunkt. Hver endring lager en ny revisjon; eldre revisjoner forblir lesbare så lenge historikken beholdes.

Vedlegg — en fil festet til et dokument. Lagret i krypterte biter og strømmet ved behov.

Automerge — den konfliktfrie flettemotoren MindooDB bruker under panseret. To personer kan redigere det samme dokumentet samtidig, og Automerge fletter endringene deres automatisk.

DAG-utforsker — en grafvisning av hver endring som noen gang er brukt på et dokument, inkludert hvordan samtidige redigeringer ble flettet sammen.

Virtuell visning — en regnearklignende trevisning over dokumentene dine som filtrerer, kategoriserer, sorterer og summerer dem. Kan hente fra én database, flere databaser eller til og med flere tenanter.

Opprinnelse — en identifikator som markerer hvilken database (eller tenant) en rad i en virtuell visning kom fra. Nyttig når én visning kombinerer flere kilder.

Materialisert indeks — de forhåndsberegnede visningsresultatene lagret i denne nettleseren så en virtuell visning kan åpnes igjen med én gang.

Haven App Store — katalogen over ferdige MindooDB-applikasjoner, åpnet fra Start. Å installere en oppføring skriver registreringen dens for deg og legger appen på Start.

App Builder — appen i butikken som bygger andre apper. Du beskriver hva du trenger; den oppretter repositoriet, publiserer appen, lar en AI-agent skrive den, og gir den til Haven for installasjon. Resultatet er en helt vanlig MindooDB-app med kildekode i din egen GitHub-konto.

Applikasjonsregistrering — den lagrede definisjonen på Haven-siden av en MindooDB-app: hvor den skal startes fra, hvordan den skal kjøre, og hvilke databaser eller visninger den har lov til å se.

Hostet pakke — et pakket sett med webressurser importert til Haven så den kan servere appen lokalt, også når du er offline.

Ekstern URL — en nettadresse for en app som hostes utenfor Haven, for eksempel en lokal utviklingsserver eller en utplassert webapp.

App-konnektor (bridge) — den sikre kanalen mellom en MindooDB-app og Haven. Apper snakker aldri direkte med dataene dine; hver lesing eller skriving går gjennom denne konnektoren så Haven kan håndheve rettighetene du ga.

Oppstartskontekst — den første informasjonen en app får fra Haven når den starter: tema, visningsområde, gjeldende bruker, oppstartsparametere og databasene den har fått tilgang til.

Kjøremodus — hvordan en registrert app startes: innebygd i Haven-vinduet, eller åpnet i sin egen nettleserfane. Forskjellig fra en flis' visningsmodus, som avgjør om flisen er en starter du dobbeltklikker, eller kjører appen inne i selve kortet.

Sandkasse — den nettleserhåndhevede isolasjonen som pakker inn hver app. Appen kan ikke nå Havens lagring, informasjonskapsler eller andre apper med mindre du eksplisitt deler data med den.

Temaforvalg — en navngitt fargepalett for Haven (for eksempel Mindoo eller Aura). Å bytte forvalg endrer aksentfarger gjennom hele appen.

Lys/mørk modus — om Haven bruker en lys eller mørk bakgrunn. Valget huskes bare i denne nettleseren.

Frittstående modus — en visningsmodus der Haven starter uten vanlige nettleserkontroller, som en dedikert app. Tilgjengelig etter at du har lagt Haven til på en telefons Hjem-skjerm.

Legg til på Hjem-skjerm — nettleserhandlingen som lagrer Haven som et startbart ikon på en telefons eller et nettbretts Hjem-skjerm.

Installasjonsdialog — det nettleserinnebygde arket som bekrefter at en progressiv webapp som Haven legges til på enheten.

Kryptert backup — én enkelt fil som inneholder alt Haven holder i denne nettleseren, kryptert med et passord du velger. Uten det passordet er filen uleselig.

Backup-passord — det ene passordet som brukes til å kryptere og senere dekryptere en backup-fil, uansett hva identitetene inni den låses opp med. Det åpner også en identitet med bare passnøkkel som gjenopprettes fra den filen på en ny enhet. Haven lagrer det aldri; mister du det, kan backupen ikke gjenopprettes.

Forhåndsvis gjenoppretting — et trygt steg som dekrypterer en backup-fil akkurat nok til å vise deg hva den inneholder, før noen lokale data røres.

Gjenopprettingsadvarsel — en merknad som vises under forhåndsvisningen når en backup inneholder databaser som må bygges opp tomme igjen eller hoppes over under gjenoppretting.

Fabrikktilbakestilling — tømmer alle Haven-data fra denne nettleseren, inkludert identiteter, tenanter, applikasjoner, hostede apper, virtuelle visninger og synkroniserte MindooDB-data. Kan ikke angres.

## Utgaver, priser og den åpne plattformen

Haven finnes i to utgaver, og den de fleste noen gang kommer til å trenge, er gratis.

Haven Community er den gratis utgaven av Haven, i beta, tilgjengelig i dag på [haven.mindoodb.com](https://haven.mindoodb.com). Det er den samme klienten MindooDB-teamet utvikler, drifter og bruker internt. «Beta» betyr her at den er brukbar til ekte arbeid, ikke en mockup — den er i aktiv utvikling, tilbakemeldinger går rett inn i veikartet, og det finnes ennå ingen formell SLA. Trenger du garanterte responstider, er det det det kommersielle supportnivået er til for.

Haven Community virker i tre utrullingstopologier. Kun lokalt, der alt bor i nettleseren din og det ikke finnes noen server i det hele tatt — perfekt for private notater og offline-demoer; i denne modusen fungerer Innstillinger → Backup-fanen også som overføringsmekanismen din, fordi en kryptert `.mdbhaven-backup`-fil inneholder brukeridentitetene, innstillingene og MindooDB-databasene dine, så du kan flytte en komplett, kun lokal Haven fra én nettleser til en annen ved å eksportere og gjenopprette. Koblet til den hostede Mindoo-demoserveren, som lar deg publisere en lokal tenant og teste ekte samarbeid med flere brukere; data på demoserveren slettes med jevne mellomrom, så den er til evaluering og ikke til produksjon. Og selvhostet, der du peker Haven mot en MindooDB-server du drifter selv, med fullstendige oppsettsinstruksjoner i [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) i MindooDB-repositoriet. Valget er ditt, og du kan flytte deg mellom topologiene når som helst.

Haven Community er også en komplett plattform for utvikling av egne apper. Du kan bygge MindooDB-apper for hånd med App SDK, eller la en AI-agent generere dem fra den strukturerte `llms-full.txt` på mindoodb.com pluss de offentlige referanseapp-repositoriene. Haven App Store kommer med en katalog av ferdige apper du kan installere med ett klikk, både til å bruke og til å se hvordan en gjennomarbeidet MindooDB-app ser ut. Mindoo Vega gjengir det samme treet av noder som et tankekart, en Kanban-tavle, et Gantt-diagram eller et regneark, med oppgavefelter, vedlegg, tidsreise gjennom dokumenthistorikken og fritekstsøk — praktisk for prosjektplanlegging der de samme dataene trenger et overblikk det ene minuttet og en bane-for-bane- eller dato-for-dato-visning det neste. Mindoo TodoManager gjør Coveys firekvadrantmetode (viktig/ikke viktig, haster/haster ikke) om til en visuell oppgaveflyt for å holde fokus på det som betyr mest. [Mindoo Weather](https://github.com/klehmann/mindoodb-app-weather) er en flis i stil med iOS' værapp som viser en tidagersvarsel pluss luftkvalitet for ett eller flere steder som settes opp gjennom en oppstartsparameter — den tilpasser seg live til flisstørrelsen Haven melder (smal: ett sveipbart kort med prikker; bredere: to til fire om gangen) og henter alle data fra nøkkelfrie Open-Meteo-API-er, så den fungerer også som referanse for UX-siden av SDK-en. Katalogen bærer også App Builder, som skriver, publiserer og installerer en ny app ut fra en beskrivelse du taster inn, og SDK Example App for utviklere som vil ha en levende referanse på hver eneste SDK-funksjon. Alle sammen er gratis å bruke.

Den underliggende MindooDB-plattformen er åpen kildekode under Apache 2.0-lisensen. Det betyr noe utover prislappen: det finnes ingen datainnlåsing. Datamodellen, det innholdsadresserte lageret og synkroniseringsprotokollen er alle dokumentert og mulige å implementere på nytt, som betyr at et team kan ta de krypterte dataene sine med seg når som helst — og det er til og med mulig å bygge helt alternative klienter oppå den samme plattformen hvis Haven ikke passer for et bestemt bruksområde. Haven er den offisielle klienten; den er ikke den eneste mulige.

Haven Enterprise er en kommersiell utgave som Mindoo GmbH bygger videre på, bygget på nøyaktig den samme MindooDB-kjernen. Funksjonene låses opp med en Enterprise-lisensnøkkel, og de kommer én etter én i stedet for alle på én gang. Den første du kan bruke allerede i dag, er at arbeidsflaten følger med på tvers av enheter og nettleserprofiler: innstillingen Arbeidsflate som følger med under Innstillinger → Generelt er nettopp denne funksjonen, og derfor står bryteren av til en lisens er importert. Fortsatt under arbeid er egen merkevarebygging (logo, farger, produktnavn og domene, så Haven føles som ditt eget produkt), et administrert brukergrensesnitt med organisasjonsspesifikke standardvalg, administrerte arbeidsområdemaler som sendes ut til brukerne så de lander i et ferdig konfigurert miljø, en intern app-butikk for å kuratere interne MindooDB-apper og apper fra tredjeparter, automatiske planlagte backuper av data i nettleseren, førsteklasses backup-verktøy for tenant-dataene som ligger på serveren din, og redigering av vanlige Office- og tekstvedlegg direkte, uten å måtte laste dem ned. Listen fortsetter å vokse etter hvert som Enterprise-klienten modnes — tilbakemeldinger fra kunder former veikartet direkte.

Å velge Haven Enterprise tar deg aldri ut av den åpne plattformen. MindooDB-kjernen og Haven-PWA-en forblir gratis og åpne; Enterprise er en separat, kommersiell klient lagt oppå. Du kan starte på Community, gå over til Enterprise senere, og i begge retninger blir dataene dine og serveren din nøyaktig der de var.

For oppdaterte detaljer, priser og listen for tidlig tilgang til Haven Enterprise, se Havens prisside på [mindoodb.com/nb/haven/pricing](https://mindoodb.com/nb/haven/pricing/).

## Veien videre

Haven er et aktivt produkt, og det er også det offentlige ansiktet til MindooDB. Noen ressurser er verdt å bokmerke.

Den enkleste måten å faktisk prøve Haven på er å åpne [haven.mindoodb.com](https://haven.mindoodb.com) i en moderne nettleser — det er den levende Community-klienten.

Produktsidene på [mindoodb.com](https://mindoodb.com/nb/) går dypere inn i posisjoneringen og sikkerhetsmodellen, og dekker de delene av historien en håndbok ikke kan — skjermbilder, veikart og den bredere MindooDB-plattformen.

[MindooDB App SDK på GitHub](https://github.com/klehmann/mindoodb-app-sdk) er TypeScript-biblioteket for å bygge apper som kjører inne i Haven. To åpne følgeprosjekter viser hvordan apper av produksjonskvalitet bygget på det ser ut: [eksempelprosjektet](https://github.com/klehmann/mindoodb-app-example) er en Vue 3-referanseapp som demonstrerer hver eneste SDK-funksjon over tre faner (Databaser, Visninger, Hendelser) — den levende demoen ligger på [app-example.mindoodb.com](https://app-example.mindoodb.com) og kan registreres i Haven med en ekstern URL for noen minutters praktisk utforsking; og [`mindoodb-app-weather`](https://github.com/klehmann/mindoodb-app-weather) fokuserer på UX-siden av SDK-en, og viser oppstartsparametere, hendelser for visningsområdet og responsiv innbygging gjennom en gjennomarbeidet flis i stil med iOS' værapp.

Inne i Haven selv, husk Hjelp-knappen i topplinjen. Hver skjerm har sin egen hjelpeartikkel, skrevet i den samme vennlige stilen som denne håndboken, og en kort gjennomgang med spotlight som framhever de viktige kontrollene. Er du i tvil på en skjerm du ikke har brukt før, åpne den først — det går som regel raskere enn å lese om den et annet sted.

Det er Haven. Et lokal-først, ende-til-ende-kryptert arbeidsområde med apphosting i en nettleserfane. Privat av design, rolig som standard, og klart enten du er på nett eller ikke.
