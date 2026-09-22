# Het Haven-handboek

Een volledige, vriendelijke gids voor MindooDB Haven — de browsergebaseerde werkruimte voor versleutelde, local-first samenwerking op MindooDB.

Dit handboek loopt alles langs wat Haven doet, in de volgorde waarin je het waarschijnlijk tegenkomt. Het is geschreven voor drie deels overlappende doelgroepen: dagelijkse gebruikers die hun tijd in de werkruimte doorbrengen, teambeheerders die tenants opzetten en apps registreren, en platformbeheerders die een MindooDB-server draaien. Je hoeft het niet van voor naar achter te lezen. Ken je de basis al, dan kun je met de kopjes direct naar wat je nodig hebt springen. Ben je helemaal nieuw, begin dan bij het begin en volg de rondleiding voor de eerste tien minuten.

## Wat Haven is en waarom het bestaat

Haven is de visuele voordeur van MindooDB. MindooDB op zichzelf is een database-engine: het slaat versleutelde documenten op een server ergens op, synchroniseert ze tussen apparaten en houdt van elke wijziging een cryptografisch ondertekende geschiedenis bij. Haven is de grafische werkruimte waar je daadwerkelijk naar kijkt. Het draait volledig in een webbrowser, bundelt alles wat je nodig hebt om MindooDB dagelijks te gebruiken, en houdt je gegevens op je eigen apparaat waar dat maar kan.

Een paar dingen maken Haven anders dan een doorsnee webapp.

Haven is local-first. Bijna alles wat je ziet komt uit een kopie — een lokale replica — die in deze browser is opgeslagen. Bladeren, bewerken, zoeken en zelfs het opbouwen van virtuele weergaven gebeurt allemaal tegen de lokale replica, waardoor Haven snel is en bruikbaar blijft als het netwerk weg is. De server wordt alleen benaderd wanneer je synchroniseert, en de gegevens op de lijn zijn altijd end-to-end versleuteld.

Haven is een progressive web app. Het kan op telefoons en tablets worden geïnstalleerd, inclusief iPhone, iPad en Android, en direct vanaf het beginscherm worden gestart zoals een native applicatie. Eenmaal geïnstalleerd opent het in standalone-modus zonder browserchroom, wat je meer schermruimte en een rustiger gevoel geeft. Op de iPhone kun je Haven zelfs meer dan één keer aan je beginscherm toevoegen — elke geïnstalleerde kopie krijgt zijn eigen privéopslag, een nette manier om persoonlijke, werk- en demogegevens op één apparaat volledig te scheiden.

Haven is een runtime-thuis voor MindooDB-apps. MindooDB-apps zijn kleine webtools die met de MindooDB App SDK zijn gebouwd. Haven start elke app in een sandboxed iframe op een aparte origin, geeft die een afgebakend zicht op de gegevens die je hebt gedeeld, en bemiddelt elke lees- en schrijfactie via een beveiligde bridge. Gehoste apps kunnen zelfs door Havens eigen service worker worden geserveerd en blijven werken als het netwerk weg is.

Haven komt met een licht en een donker thema die standaard de systeemvoorkeur volgen en handmatig te wisselen zijn. Het actieve thema wordt live doorgegeven aan elke MindooDB-app die binnen Haven draait, zodat ingesloten apps automatisch bij Havens uiterlijk passen zonder extra werk.

Onder dit alles ligt dezelfde belofte die MindooDB overal elders doet: sleutels blijven op apparaten, servers zien alleen ooit ciphertext, en zelfs een volledig gekraakte server levert niets leesbaars op. Haven is ontworpen om de meest comfortabele manier te zijn om met die belofte te leven.

## De kernbegrippen in vijf minuten

Als je deze handvol woorden begrijpt, leest de rest van het handboek vanzelf.

Een gebruikersidentiteit is je account binnen Haven. Het is een lokaal versleuteld bestand met je openbare gegevens en je versleutelde privésleutels, dat wordt ontgrendeld met een passkey op je apparaat of met een wachtwoord dat je zelf hebt gekozen. Identiteiten worden lokaal in je browser aangemaakt en verlaten die nooit, tenzij je ze zelf exporteert. Haven kan meerdere identiteiten naast elkaar bewaren en er via de bovenbalk tussen wisselen. Elk geheim kwijt dat een identiteit ontgrendelt, betekent dat die identiteit definitief weg is — er is geen herstellink, want niemand buiten je apparaat heeft de sleutel.

Een tenant is de privéwerkruimte van je team binnen MindooDB. Iedereen die een bepaalde verzameling databases kan zien, is lid van dezelfde tenant. Tenants bevatten een directory-database (waar gebruikersregistraties en tenantbrede instellingen staan), een of meer applicatiedatabases, en een set versleutelingssleutels. Tenants worden volledig aan de clientzijde aangemaakt en kunnen naar een server worden gepubliceerd wanneer je klaar bent om samen te werken.

Een lokale replica is de in de browser opgeslagen, gesynchroniseerde kopie van de databases van een tenant. Dat is wat Haven direct laat aanvoelen. Werken vanuit de lokale replica is snel, werkt offline en is de aanbevolen manier om te bladeren en te bewerken.

Een database is een verzameling gerelateerde documenten binnen een tenant — contacten, facturen, notities, wat het team ook nodig heeft. Een document is één item binnen die database. Elk document is een Automerge CRDT, de technologie waardoor twee mensen tegelijk aan hetzelfde document kunnen werken en hun wijzigingen automatisch worden samengevoegd, zonder conflictdialoog.

Elke wijziging aan een document wordt met de privésleutel van de auteur ondertekend en aan de geschiedenis van het document toegevoegd. Elke wijziging is ook cryptografisch verbonden met de wijziging die eraan voorafging, een beetje zoals een blockchain, zodat de reeks bewerkingen een manipulatievrije keten vormt in plaats van een losse verzameling revisies. Die geschiedenis is wat Haven in de databasebrowser en in de DAG-verkenner laat zien. Omdat wijzigingen ondertekend en geketend zijn, kan niemand het verleden stil herschrijven: een eerdere wijziging aanpassen of weglaten zou elke schakel erna breken.

Een KeyBag is een lokale, versleutelde opslag van de versleutelingssleutels die een tenant nodig heeft, die wordt geopend door de identiteit die er eigenaar van is. Elke gebruiker houdt zijn eigen KeyBag in zijn browser. Een standaardsleutel wordt met elk lid van een tenant gedeeld; benoemde sleutels zijn extra sleutels die aan een kleinere groep kunnen worden gegeven voor gevoelige documenten.

Een virtuele weergave is een spreadsheetachtige boomstructuur die documenten filtert, categoriseert, sorteert en optelt. Een weergave kan uit één database, uit meerdere databases of zelfs uit meerdere tenants trekken; zo beantwoord je vragen over je gegevens heen in plaats van alleen binnen één database.

De werkruimte bestaat uit tegels op pagina's, gebundeld in groepen. Een tegel — soms een chicklet genoemd — is een versleepbare, vergrootbare kaart die een database opent, een app start of een notitie, een webpagina, een video of een diagram toont. Een pagina is een tabblad vol tegels. Een groep clustert gerelateerde tegels onder een gedeelde, kleurgecodeerde kop.

Een applicatieregistratie is de aan Havens kant opgeslagen definitie van een MindooDB-app: waar die staat, hoe die draait, en welke databases of weergaven die mag zien. Wanneer een app start, praat die met Haven via een bridge (soms de app-connector genoemd), het beveiligde kanaal waarmee Haven de rechten die je hebt gegeven kan handhaven. De sandbox is de door de browser gehandhaafde isolatie die voorkomt dat een app bij Havens opslag, cookies of andere apps kan komen.

Dat zijn de bouwstenen. Al het andere in Haven is een scherm om ermee te werken.

## Je weg vinden in Haven

Haven zet alles op één vlak. Bovenaan loopt een smalle bovenbalk, en daaronder zit de werkruimte — de pagina waar je begint, waar je naar terugkeert en vanwaar je navigeert. Er is geen zijbalk en geen aparte menuboom om te leren.

De bovenbalk is op elk scherm hetzelfde. Links is het woordmerk MindooDB Haven een link terug naar de werkruimte, waar je ook bent. Rechts staan twee dingen: een identiteitschip die de actieve gebruiker toont, en een Help-knop. Druk op de chip om de identiteitswisselaar te openen; klik met de rechtermuisknop of houd hem ingedrukt voor een snelmenu waarmee je tussen lichte en donkere modus wisselt of de sessie vergrendelt. De Help-knop opent een contextuele hulplade voor het scherm waar je bent. Elk scherm heeft zijn eigen artikel, geschreven in dezelfde vriendelijke stijl als dit handboek, plus een korte rondleiding die de bedieningselementen uitlicht die het waard zijn om te kennen — voel je je ooit verloren, dan is die knop het eerste om te proberen. Op een telefoon of tablet port Haven je af en toe vanuit de bovenbalk aan om het aan je beginscherm toe te voegen.

De werkruimte opent op een tabblad met de naam Start, en Start is Havens voordeur. Bovenaan loopt een rij van zes snelkoppelingstegels, één voor elk van Havens eigen schermen: Installatiewizard voor een nieuwe omgeving, Haven App Store, Synchroniseren met server, Snelscan, Virtuele weergaven en Instellingen. Elk krijgt verderop in dit handboek zijn eigen paragraaf. Onder de snelkoppelingen toont Start één tegel voor elke applicatie die je hebt geïnstalleerd, zodat het ook dient als catalogus van wat je beschikbaar hebt. Dubbelklik op een tegel om die te openen, of gebruik de ⋮-knop in de hoek voor de acties die erbij horen.

Start is met opzet vast. De zes snelkoppelingen staan altijd op dezelfde plek en kunnen niet worden verplaatst, verwijderd of herschikt, en Start is niet de plek voor je eigen tegels — het is de ene pagina waarop je kunt vertrouwen dat die er morgen hetzelfde uitziet. Alles wat je zelf inricht staat op de pagina's die je naast Start aanmaakt, beschreven onder Werkruimte hieronder.

De app-lade is hoe je tussen de dingen die je open hebt beweegt. Zodra er een applicatie draait of een Haven-scherm open is, verschijnt er bovenaan het inhoudsgebied een klein pijlgreepje; als je erop klikt, schuift er een lade naar beneden in twee delen. Weergaven toont de Haven-schermen die je open hebt — Synchronisatie, Instellingen, Virtuele weergaven, de installatiewizard — en Apps toont de MindooDB-applicaties die op dat moment draaien. Boven beide staat een vermelding Terug naar werkruimte. Vanaf de tegel van een applicatie in de lade kun je ook de lokale databases van die app tegen de server synchroniseren, de app opnieuw laden, een infodialoog openen of de app sluiten.

Twee sneltoetsen maken het de moeite waard om de lade goed te leren kennen. Cmd+Shift+Enter brengt je van overal terug naar de werkruimte, ook vanuit een draaiende applicatie, en Cmd+Shift+Space opent en sluit de lade. Op Windows en Linux druk je op Ctrl in plaats van Cmd. Haven geeft beide door aan ingesloten applicaties, zodat ze blijven werken ook als een app de toetsenbordfocus heeft.

Wat je opent blijft open. Start een applicatie of open de pagina Synchronisatie, dwaal ergens anders naartoe, en die zit nog in de lade wanneer je terugkomt, met zijn scrollpositie, niet-opgeslagen bewerkingen en open tabbladen onaangeroerd.

Wanneer je Haven op een telefoon installeert en vanaf het beginscherm start, opent het in standalone-modus, zonder de adresbalk en de tabbladenstrook van de browser. Bepaalde schermen binnen Haven — vooral immersieve, zoals een applicatie die schermvullend draait — verbergen om dezelfde reden ook de bovenbalk.

## Je eerste 10 minuten

De eerste keer dat je Haven opent is er niets te vinden en niets in te stellen: je komt direct in de installatiewizard, die het hele begin — identiteit, beheerder, tenant, of aansluiten bij een bestaand team — tot een korte begeleide stroom maakt. Haven bepaalt dit door naar het apparaat te kijken. Zodra het zowel een benoemde gebruikersidentiteit als een tenant vindt, land je bij het openen van Haven in de werkruimte; tot dan land je in de wizard. Je kunt er altijd naar terug via de tegel Installatiewizard voor een nieuwe omgeving op Start, en dat is ook hoe je later een tweede tenant toevoegt. Alles wat de wizard doet kun je ook met de hand doen via Instellingen → Gebruikers-ID's en Instellingen → Tenants, maar de wizard is met afstand de eenvoudigste weg, dus gebruik hem wanneer je kunt.

De wizard opent met een korte introductie (end-to-end versleuteld, local-first, zero-trust-servers) en drie grote knoppen: Een tenant aanmaken, Bij een team aansluiten en Tenants openen. Daaronder leggen twee kaarten uit wat elke route eigenlijk doet. Heeft Haven al een ontgrendelde identiteit, dan vertelt een kleine banner je dat — de wizard hergebruikt die graag en slaat de identiteitsstap over als je dat wilt.

### Route één: je eigen tenant beginnen

Begin je helemaal opnieuw, druk dan op Een tenant aanmaken. De wizard loopt vier stappen met je door op één pagina.

Stap één, maak je persoonlijke gebruikersidentiteit aan. Dit is je account binnen Haven — een klein, lokaal versleuteld bestand met je openbare gegevens en je versleutelde privésleutels. Je kunt de identiteit hergebruiken die al ontgrendeld is in de bovenbalk, of een geheel nieuwe aanmaken door een gebruikersnaam in te voeren (bijvoorbeeld `cn=user/o=acme`).

Kies daarna hoe je die identiteit dagelijks wilt ontgrendelen. Haven kiest Passkey voor als je browser het ondersteunt, omdat dat zowel de makkelijkere als de sterkere optie is: je apparaat vraagt om Face ID, Touch ID, Windows Hello of een security key, en leidt daar lokaal de sleutel uit af die je privésleutels opent. Een wachtwoord is het alternatief, en dat is de juiste keuze op een gedeeld apparaat waar iemand anders de ontgrendelcode kent, of wanneer je dezelfde identiteit ook in de console wilt kunnen gebruiken. Hoe dan ook blijft het geheim op dit apparaat — er is geen herstelprocedure en geen server die je identiteit voor je kan ontgrendelen, dus bewaar het geheim dat je kiest voordat je verdergaat. De andere methode kun je later toevoegen via Instellingen → Gebruikers-ID's.

Stap twee, zet een aparte beheerdersidentiteit op. MindooDB houdt de tenantbeheerder en de dagelijkse app-gebruiker bewust gescheiden, zodat één gecompromitteerd geheim niet zowel het directorybeheer als het dagelijkse documentwerk kan overnemen. Je kiest hier hoe de beheerdersidentiteit wordt beschermd: laat Haven een wachtwoordzin van zes woorden genereren, of typ zelf een wachtwoord met het gebruikelijke herhaalveld. De gegenereerde wachtwoordzin wordt één keer getoond, met knoppen om hem te kopiëren of als tekstbestand te downloaden, en een aanvinkvakje waarmee je bevestigt dat je hem hebt bewaard, zodat je er niet per ongeluk langs kunt. In beide gevallen is het met opzet geen passkey: een beheerder die je alleen met de Face ID van dit apparaat kunt ontgrendelen, is een beheerder die je samen met het apparaat kwijt bent — en beheerderswerk is precies wat je nodig hebt nadat je een laptop hebt vervangen. Bewaar hem waar je je andere noodgegevens bewaart.

Stap drie, maak de tenant zelf aan. Haven genereert de tenant-ID voor je, en die kan daarna niet meer worden gewijzigd. Dat is bewust: zodra meerdere teams een MindooDB-server delen, moeten tenant-ID's uniek zijn, en een ID die iemand met de hand heeft getypt is een ID dat op een dag botst met dat van iemand anders. Wat je wél kiest is het tenantlabel — een korte, makkelijk te onthouden naam zodat je deze tenant later herkent — en elke beheerder kan die altijd wijzigen, want het label is er alleen voor mensen. Haven genereert vervolgens de versleutelingssleutels van de tenant, een standaardsleutel voor je inhoud en een tweede voor de toegangsdirectory, slaat ze op in je lokale KeyBag en koppelt beide identiteiten. In dit stadium blijft alles lokaal in je browser; er is nog niets naar een server gestuurd.

Stap vier, je bent klaar. Haven zet je in je lege werkruimte, al ontgrendeld en al binnen de nieuwe tenant. Wanneer je klaar bent om samen te werken, publiceer je de tenant naar een MindooDB-server: de pagina Synchronisatie biedt een knop Naar server overzetten voor elke tenant die nog alleen lokaal bestaat, en hetzelfde staat in Instellingen → Tenants.

### Route twee: bij een bestaand team aansluiten

Heeft een teamgenoot al een tenant op een MindooDB-server opgezet, druk dan op Bij een team aansluiten. De wizard gebruikt dezelfde indeling van vier stappen, maar volgt de toetredingsprocedure van MindooDB in drie stappen, waarbij je privésleutels dit apparaat nooit verlaten.

Stap één, maak je persoonlijke gebruikersidentiteit aan (of hergebruik de actieve), net als in de andere route.

Stap twee, verstuur een toetredingsverzoek. Haven bouwt uit je openbare sleutels een URL voor het toegangsverzoek — geen geheimen — en toont die met een knop Toegangsverzoek kopiëren. Stuur die URL via een willekeurig kanaal naar de tenantbeheerder (e-mail, chat, een ticketsysteem); hij mag open worden gedeeld, want hij bevat alleen je openbare sleutels. De beheerder opent zijn Haven, voert Tenant-toegang verlenen uit op je verzoek, en stuurt twee dingen terug: een URL met het toetredingsantwoord en een kort gedeeld wachtwoord. Belangrijk: dat gedeelde wachtwoord moet via een apart, veilig kanaal komen — een telefoongesprek, een andere messenger, of in persoon — want het antwoord bevat de versleutelingssleutels voor de werkruimte.

Stap drie, voltooi de toetreding. Plak de URL met het toetredingsantwoord in de wizard, voer de server-URL in die de tenant host (er zijn snelkoppelingen met één klik voor bekende servers), en typ het gedeelde wachtwoord dat de beheerder je apart heeft gegeven. Haven valideert de server, haalt de eerste directorygegevens op en voegt de tenant toe aan je Haven.

Stap vier, je bent binnen. Haven zet je in de net toegetreden tenant en de werkruimte is klaar om met tegels te worden gevuld.

### Na de wizard

Zodra de welkomstwizard klaar is, is het dagelijkse pad hetzelfde, welke route je ook hebt genomen.

Open de werkruimte. Start heeft al zijn zes snelkoppelingstegels; wat er nog niet is, is iets van jezelf. Voeg via het toevoegmenu een pagina naast Start toe en gebruik daarna hetzelfde menu om er een databasetegel op te zetten die naar een van de databases in je tenant wijst. Dubbelklik op de tegel om de databasebrowser te openen en de documenten te bekijken.

Installeer een app. Open Haven App Store vanaf Start, kies iets dat nuttig lijkt en installeer het. Het verschijnt direct als tegel op Start, en vanaf daar kun je het op een van je eigen pagina's plaatsen.

Voer een synchronisatie uit. Open Synchroniseren met server vanaf Start en druk op Alles synchroniseren, of gebruik Synchroniseren per rij als je maar één database wilt verversen. Zodra de statuskolom een groen vinkje toont, is je lokale replica bij met de server.

Kom terug naar de werkruimte en blijf tegels toevoegen — applicaties, notities, webpagina's, dashboards, alles wat je werkruimte als thuis laat voelen.

Voelt een stap abstract, open dan de Help-knop op dat scherm. De ingebouwde hulp heeft een rondleiding die precies uitlicht waar je moet klikken. En je kunt de installatiewizard altijd opnieuw openen via zijn tegel op Start — hij hergebruikt graag een bestaande identiteit of helpt je er extra aan te maken.

### Haven is multi-tenant van opzet

Niets houdt op bij één tenant. De welkomstwizard kan altijd opnieuw worden doorlopen, en elke nieuwe tenant is cryptografisch onafhankelijk van elke andere — eigen versleutelingssleutels, eigen KeyBag-vermelding, eigen beheerdersketen, eigen ondertekende geschiedenis. Die onafhankelijkheid is wat het veilig maakt om heel verschillende contexten onder één dak te houden.

Een veelvoorkomende opzet is drie of vier tenants naast elkaar: één voor werk, één voor persoonlijke zaken zoals huishoudplanning of een eigen project, en nog een die je met een partnerbedrijf deelt voor samenwerking tussen organisaties. Je kunt dezelfde gebruikersidentiteit in allemaal gebruiken of per tenant een eigen identiteit aanmaken — de keuze is aan jou, want niets verbindt de tenants met elkaar, behalve dat ze toevallig in dezelfde browser wonen.

Haven is echt multi-tenant, niet single-tenant met een wisselknop. Je kunt meerdere tenants tegelijk ontgrendeld en actief hebben, hun gegevens binnen één werkruimtepagina mengen, en databases uit verschillende tenants achter aparte logische handles aan dezelfde applicatie koppelen, zodat die over organisatiegrenzen heen kan werken zonder ooit meer te zien dan zou moeten. Virtuele weergaven gaan nog een stap verder: één weergave kan uit meerdere databases in meerdere tenants trekken en hun documenten categoriseren, sorteren en optellen alsof het één gegevensverzameling is. Zo kan een persoonlijke planningsweergave je privé-takenlijst combineren met de werktaken die in de bedrijfstenant aan je zijn toegewezen, terwijl de twee gegevensverzamelingen met volledig verschillende sleutels zijn versleuteld en naar volledig verschillende servers worden gesynchroniseerd.

Voeg tenants toe wanneer er een nieuwe context ontstaat. Ze naast elkaar laten staan is goedkoop, en door de cryptografische scheiding hoef je je nooit zorgen te maken dat gegevens van de een naar de ander weglekken.

## Haven op meer dan één apparaat gebruiken

Haven bewaart je gegevens in de browser waarin het draait. Dat is wat het snel maakt en wat je sleutels van andermans servers weghoudt, maar het betekent ook dat een tweede browser — Safari op je iPhone, een werklaptop, nog een geïnstalleerde kopie van Haven op dezelfde telefoon — als een vreemde begint. Die heeft zijn eigen opslag, zijn eigen apparaatsleutels, en geen enkele manier om iets te lezen totdat een apparaat dat je al vertrouwt hem binnenlaat. Deze paragraaf gaat over dat moment.

Er zijn twee verschillende rechten in het spel, en die gescheiden houden is wat het model veilig maakt. Het eerste is het recht om te synchroniseren: een tenantbeheerder geeft je gebruikersnaam toegang, en vanaf dan is de server bereid om je apparaten versleutelde gegevens te geven. Het tweede is het recht om te lezen: de sleutels die die ciphertext weer in documenten veranderen. Een server kan het eerste geven, want hij verplaatst alleen bytes, maar hij kan het tweede nooit geven, omdat hij nooit een sleutel in handen heeft gehad. Een spiksplinternieuw apparaat kan dus een synchronisatie afronden, elke byte van een database lokaal hebben, en er nog steeds niets in kunnen lezen. Haven toont nooit een document dat het niet kan ontsleutelen, dus het symptoom is niet een rij die weigert te openen: het is een database die leeg lijkt, of een weergave die veel korter is dan je verwachtte, op een apparaat dat net een geslaagde synchronisatie meldde. Dat is geen bug en geen halfafgemaakte toetreding; het is het ontwerp, en de banner die hieronder wordt beschreven is wat de twee van elkaar onderscheidt. De databasebrowser zet er ook een getal op: de kop telt de documenten die je kunt lezen en vermeldt, wanneer dit apparaat documenten heeft die je sleutels niet kunnen openen, hoeveel er verborgen zijn — "Documenten (3) · 7 verborgen" is een apparaat dat er tien heeft en er drie kan lezen. Het getal telt wat hier is aangekomen, niet wat de tenant bevat, dus het groeit zodra een synchronisatie meer binnenhaalt.

Wat het gat overbrugt is je gebruikerssleutel. Iedereen in een tenant heeft er precies één — een versleutelingssleutelpaar dat bij jou hoort en niet bij een apparaat of bij de tenant zelf. De openbare helft wordt binnen de tenant gepubliceerd zodat teamgenoten en beheerders voor je kunnen versleutelen; zo bereikt de standaardsleutel van de tenant je in de eerste plaats. De privéhelft bestaat alleen op de apparaten die je hebt goedgekeurd. Een apparaat goedkeuren betekent dat er nog een kopie van die privéhelft in de gebruikersdirectory van de tenant wordt geschreven, zo ingepakt dat alleen de eigen sleutel van het nieuwe apparaat hem kan openen. De server bewaart en doorgeeft die kopie zoals al het andere, zonder hem ooit te kunnen lezen.

Op het nieuwe apparaat zie je onderaan het scherm een banner: This device is waiting for approval. Die noemt welke toegang vastzit — bijvoorbeeld "Tenant acme · op Server1/ACME", waarbij de tweede helft de eigen canonieke naam van de server is, dezelfde die het tabblad Tenants toont, met het adres als terugvaloptie als de server er nooit een heeft gemeld — want dezelfde tenant kan via meer dan één server tegelijk worden gesynchroniseerd, en een kaal "wacht" vertelt je dan niets. Daaronder staan de sleutels die je mist, zodat je weet wat er terugkomt als het wachten voorbij is: documenten die de standaardsleutel nodig hebben, blijven tot dan verborgen. Ben je vanaf dit apparaat bij meerdere tenants aangesloten, dan vertelt een regel hoeveel er nog achter deze in de wachtrij staan. De banner staat bewust op elke pagina en niet alleen in de werkruimte, want een apparaat zonder sleutels is overal buitengesloten en de weg eruit moet binnen bereik blijven. Check again leest de directory ter plekke opnieuw; Open restore leidt naar de laatste redmiddel die aan het eind van deze paragraaf wordt beschreven.

Op een apparaat dat al is goedgekeurd, komt de andere helft van de procedure kort na het ontgrendelen als dialoog binnen: Een nieuw apparaat goedkeuren. Die toont het label van het apparaat, dezelfde regel met tenant en server zodat je kunt zien wat je gaat weggeven, en wanneer het apparaat is toegevoegd. Dit apparaat goedkeuren schrijft de ingepakte kopie van je gebruikerssleutel en stuurt die naar buiten. Niet nu stelt de vraag uit tot de volgende keer dat Haven start, en dat is het juiste antwoord wanneer je midden in iets zit en het apparaat echt van jou is. Niet meer vragen is het definitieve antwoord: het apparaat wordt als geweigerd vastgelegd, elk goedgekeurd apparaat stopt ernaar te vragen, en het verschijnt als Verborgen in je apparaatlijst. Weigeren gooit het apparaat niet uit de tenant — het kan nog synchroniseren — het krijgt alleen nooit sleutels, dus alles wat het synchroniseert blijft er onzichtbaar. Wachten er meerdere apparaten, dan vraagt Haven er één voor één naar.

Goedkeuring reist via de gebruikersdirectory van de tenant, waardoor het een synchronisatie is en geen live procedure. De twee apparaten praten nooit direct met elkaar en het goedkeurende apparaat hoeft niet open te blijven: de goedkeuring wordt geschreven, naar de server gestuurd en opgepikt door het wachtende apparaat zodra dat weer ophaalt — bij de volgende directorysynchronisatie, wanneer je op Check again drukt, of wanneer Haven de volgende keer start. Kan geen van beide apparaten de server bereiken, dan beweegt er niets tot een van de twee dat wel kan.

Instellingen → Gebruikers-ID's heeft het volledige beeld onder Je apparaten, en dat is waar je heen gaat als een dialoog is weggeklikt of een weigering moet worden teruggedraaid. Elke rij is één apparaat met zijn label, wanneer het is toegevoegd, bij welke tenant het hoort, en zijn status: Goedgekeurd, Wacht op goedkeuring of Verborgen. Wachtende apparaten krijgen een knop Goedkeuren, verborgen apparaten een knop Toch toestaan die het apparaat terugzet in de wachtstand zodat het normaal kan worden goedgekeurd. Eén regel verrast mensen de eerste keer: goedkeuring moet komen van een apparaat dat al is goedgekeurd. Een apparaat dat zelf nog op goedkeuring wacht, ziet die zin in plaats van een knop en kan zichzelf niet binnenlaten — kon het dat wel, dan was het hele mechanisme decoratie. Het betekent ook dat het tweede apparaat op een gepubliceerde tenant vanaf het eerste moet worden goedgekeurd, dus keur het goed zolang je beide nog hebt.

Is een tenant nooit gepubliceerd, dan verschijnt hiervan niets. Er is geen gebruikersdirectory op een server om te raadplegen en geen ander apparaat om te vragen, dus het eerste apparaat verzegelt zijn eigen gebruikerssleutel en gaat aan de slag. De procedure begint pas te tellen op het moment dat een tenant op een server staat en er een tweede apparaat opduikt.

Er is nog één geval waarin Haven helemaal niets vraagt. Verleen je het toetredingsverzoek voor je nieuwe apparaat zelf, vanaf een apparaat dat je gebruikerssleutel al heeft, dan wordt de kopie als onderdeel van het toegang verlenen weggeschreven en komt de nieuwkomer direct leesbaar binnen. Stilte is daar de goede uitkomst, geen ontbrekende stap. Het is wanneer iemand anders de toetreding goedkeurt — typisch een tenantbeheerder die je registreert — dat het nieuwe apparaat in de wachtstand landt en een van je eigen apparaten het werk moet afmaken.

Soms kan Haven het niet vaststellen. Een oranje banner met de tekst Haven could not yet tell whether this device is approved betekent dat de gebruikersdirectory helemaal niet gelezen kon worden — meestal omdat de server onbereikbaar is — en niet dat iemand je heeft geweigerd. Controleer het netwerk en druk op Check again. Waar opnieuw controleren het antwoord nooit zou kunnen veranderen, blijft Haven stil in plaats van een banner eeuwig te laten staan.

De ene situatie die deze procedure niet kan repareren, is dat je alle goedgekeurde apparaten tegelijk kwijt bent, want dan is er niemand over om de vervanger goed te keuren. Daar is de tenant-noodafdruk op het tabblad Back-up voor, en daarom linkt de wachtbanner rechtstreeks naar het tabblad Herstellen. Druk er één per tenant af terwijl alles rustig is; de paragraaf over back-up en herstel legt uit wat erop staat.

## Werkruimte

De werkruimte is je dagelijkse thuis. Je richt databases, applicaties, notities, webpagina's, video's en diagrammen in als versleepbare tegels over meerdere pagina's, zoals beginschermen op een telefoon. De indeling is persoonlijk: standaard wordt die alleen in deze browser bewaard, zodat die direct laadt en offline werkt. Wil je dezelfde indeling op je andere apparaten, dan slaat de instelling Meereizende werkruimte onder Instellingen → Algemeen die op in je tenant, versleuteld voor jou alleen.

Pagina's zijn de tabbladen bovenaan de werkruimte. De eerste is altijd Start, beschreven onder Je weg vinden in Haven: Havens eigen zes snelkoppelingen plus een tegel voor elke geïnstalleerde applicatie. Start is alleen-lezen, dus je kunt er geen eigen tegels op neerzetten en niets herschikken, en het is de ene pagina die er altijd hetzelfde uitziet.

Al het andere is van jou. Voeg zoveel pagina's naast Start toe als je wilt — één per project, één per rol, één voor dagelijkse dashboards, één voor persoonlijke links — elk met zijn eigen raster van tegels. Klik met de rechtermuisknop op een paginatabblad om die te hernoemen, te verplaatsen of te verwijderen.

Tegels zijn de kaarten op het raster. Sleep een tegel aan zijn kop om die te verplaatsen, sleep aan de hoek om de grootte te wijzigen, of klik met de rechtermuisknop voor het volledige contextmenu. Laat een tegel op een ander paginatabblad vallen om die daarheen te verplaatsen. Laat een tegel op een andere tegel vallen om een groep te beginnen.

Groepen clusteren gerelateerde tegels onder een gedeelde, kleurgecodeerde kop. Een groep is een prima manier om de tegels van één project visueel bij elkaar te houden — bijvoorbeeld de database, de draaiende app en een referentienotitie voor hetzelfde team. Klik met de rechtermuisknop op de groepskop om die te hernoemen, de kleur te wijzigen of de groep op te heffen zodat de tegels weer gewone kaarten worden.

Er leven verschillende soorten tegels op hetzelfde raster.

Een databasetegel wijst naar één MindooDB-database. Dubbelklik erop om de databasebrowser te openen. Gebruik het contextmenu om te wisselen welke kopie van de database de tegel toont — een lokale replica voor snelheid en offline werken, of een live serverlocatie voor de meest actuele stand. Databasetegels onthouden de tenant, de database en de bron die je het laatst gebruikte, dus ze zijn ook een handige bladwijzer terug naar de rest van MindooDB.

Een applicatietegel start een MindooDB-app, en twee afzonderlijke instellingen bepalen hoe die zich gedraagt. De Weergavemodus van de tegel zelf is of Launcher, een kaart waarop je dubbelklikt, of Ingesloten, waarbij de app rechtstreeks in de werkruimtekaart draait — perfect voor kleine tools die je in één oogopslag bekijkt, zoals een invulformulier of een minidashboard. De Runtimemodus van de registratie bepaalt vervolgens wat een start werkelijk doet: Insluiten in Haven opent de app over de volle breedte binnen het Haven-venster, waar de app-lade het wisselen verzorgt, terwijl Openen in nieuw venster de app een eigen browsertabblad geeft — nuttig voor een tweede monitor, of om Haven en de app naast elkaar te lezen. Apps die binnen Haven zijn geopend blijven op de achtergrond draaien terwijl je ergens anders navigeert, dus hun scrollpositie, niet-opgeslagen bewerkingen en open tabbladen zijn er nog wanneer je terugschakelt.

Teksttegels bevatten opgemaakte notities. Webtegels sluiten een willekeurige URL in als minibrowser, waarmee je een partnersysteem of het dashboard van een ander team naast de MindooDB-gegevens houdt die het documenteert. Videotegels spelen YouTube-inhoud voor tutorials en rondleidingen. Mermaid-tegels renderen live architectuurdiagrammen en flowcharts direct op het raster. Deze inhoudstegels zijn persoonlijk — ze leven alleen in deze browser — en zijn daarmee ideaal voor cheatsheets, dagelijkse links en actueel referentiemateriaal.

Een zoekbalk bovenaan de werkruimte filtert tegels over pagina's heen op naam, database, tenant, tag of server. Op Start kun je wat er staat ook sorteren op laatst gebruikt, op tenant of alfabetisch, wat de snelste manier wordt om iets te vinden zodra je meer dan een handvol applicaties hebt geïnstalleerd.

## Applicaties en de Haven App Store

MindooDB-apps zijn kleine webtools die binnen Haven draaien met een afgebakend zicht op je gegevens. Er een krijgen is één klik in de Haven App Store; alles daarna — starten, configureren, bijwerken, verwijderen — gebeurt vanaf de eigen tegel van de app op Start.

De Haven App Store is de catalogus met kant-en-klare MindooDB-applicaties, en die opent als dialoog bovenop de werkruimte in plaats van je ergens anders naartoe te brengen. Blader door de catalogus, open een vermelding om de beschrijving, schermafbeeldingen en versie te lezen, en druk dan op Installeren. Haven vraagt in welke tenant de app moet werken en hoe die moet heten, en Nu installeren maakt het werk af. Er is geen registratieformulier in te vullen: Haven schrijft er een voor je uit de catalogusvermelding, geeft de app de databases die die opgeeft, en de app verschijnt als tegel op Start, klaar om te starten. Heeft een gehoste app een nieuwere build klaarstaan, dan draagt de tegel van de App Store een klein badge met het aantal beschikbare updates.

Een registratie is het opgeslagen contract tussen Haven en een app: Haven belooft de app te starten zoals de registratie beschrijft en alleen de gegevens vrij te geven die de koppelingen toestaan, en de app stemt ermee in voor elke lees- en schrijfactie via Havens SDK-connector te gaan. Installeren uit de App Store levert er automatisch een op, en daarom hoeven de meeste mensen nooit over het begrip na te denken. Het begint te tellen op de dag dat je wilt wijzigen wat een app mag zien.

Alles wat je met een geïnstalleerde app kunt doen, hangt onder het ⋮-menu op zijn tegel op Start. Applicatie starten start de app met de actieve gebruiker, of brengt je in de bestaande sessie als die al draait in plaats van een tweede te starten. Applicatie configureren opent de registratie om te bewerken, en daar staan de hosting, de runtime en de gegevenskoppelingen die hieronder worden beschreven; wijzigingen worden van kracht bij de volgende start van de app, en er zijn geen codewijzigingen in de app zelf nodig. Over deze applicatie toont de metadata, zoals de app-ID en de huidige versie. Controleren op updates verschijnt bij apps die vanaf een gehoste bundel worden geserveerd en haalt een nieuwere build op als de uitgever er een heeft uitgebracht. Applicatie verwijderen deïnstalleert de app weer. De tegel van de App Store heeft één eigen extra vermelding, Applicatie importeren, voor het binnenhalen van een voorverpakte registratie die niet uit de catalogus komt.

Twee dingen bepalen hoe Haven een app serveert. Ten eerste, waar de code staat. Een Externe URL wijst naar een ontwikkelserver of een webapp die ergens anders is uitgerold; die gebruik je tijdens het ontwikkelen of wanneer een ander team de app host. Een Gehoste bundel is een gebundelde set webassets die in Haven zelf wordt geïmporteerd. Zodra die lokaal is opgeslagen, kan Haven de bundel via zijn eigen service worker uitleveren, wat betekent dat de app uit de lokale opslag start, ook als er geen netwerk is — dit is de route naar echt offlinegeschikte apps. In de gehoste modus geldt ook een netwerktoelatingslijst die jij beheert; leeg betekent geen extern netwerk. Zie [hosted-app isolation](hosted-app-isolation.md) voor de sandbox, de Vite-plugin en waarom een lokale `vite dev` op een externe start-URL blijft. Ten tweede, hoe die draait. Insluiten in Haven draait de app in een iframe binnen het Haven-venster, waar de app-lade het wisselen verzorgt. Openen in nieuw venster start die in plaats daarvan als zelfstandig browsertabblad, wat nuttig is voor een tweede monitor.

Het deel van de registratie dat je werkelijk beschermt, is de gegevenskoppeling. Voor elke database die je de app wilt laten zien, kies je de logische naam waarmee de app die aanspreekt en de rechten die je geeft: alleen lezen of lezen/schrijven, en of verwijderen, bijlagen, revisiegeschiedenis en het aanmaken van door de app gedefinieerde virtuele weergaven zijn toegestaan. Je kunt ook databases uit verschillende tenants of van verschillende servers achter aparte logische handles koppelen, waardoor één app over grenzen heen kan werken zonder ooit meer te zien dan zou moeten.

Wanneer een app start, praat die niet direct met de MindooDB-opslag. Die roept de SDK-connector aan, die een sessie met Haven opent, en elke lees-, schrijf-, query-, bijlage- of geschiedenisaanvraag loopt via die connector. Haven valideert elk verzoek tegen de koppeling en de rechten die je hebt ingesteld, dus zelfs als de app zich zou willen misdragen, weigert de bridge.

Registraties reizen als JSON-pakketten. Applicatie exporteren, binnen de dialoog Applicatie configureren, schrijft er een; Applicatie importeren op de tegel van de App Store leest die terug in. Een pakket kan de bestanden van de gehoste bundel samen met de definitie meenemen, zodat een app die in de ene browser is ontwikkeld aan een teamgenoot kan worden overgedragen of naar een andere omgeving kan verhuizen zonder dat iemand de registratie met de hand opnieuw hoeft op te bouwen.

Niet elke app komt uit de catalogus, en het menu Nieuwe applicatie van de store dekt de rest. Vanaf een URL registreert een app die op een adres staat dat je plakt — een fork, een previewdeployment of een builder die op je eigen machine draait; Haven leest de `haven-app.json` van de app op dat adres en laat je zien wat die vraagt voordat er iets wordt weggeschreven. Nieuwe lege applicatie opent een lege registratie voor wanneer je de hosting en de koppelingen met de hand wilt invullen. Op maat, gemaakt door AI leidt naar de App Builder, waar de volgende paragraaf over gaat.

Een goede vuistregel wanneer je de toegang van een app uitbreidt: begin met alleen lezen op één database, krijg de app aan het werk, en geef pas daarna meer. Het is veel makkelijker om later schrijfrechten toe te voegen dan om ze in haast weer af te nemen.

## Een app bouwen met de App Builder

Eén app in de store bestaat om andere apps te maken. De App Builder neemt een beschrijving van de tool die je team mist — een takenbord, een reserveringslijst, een dienstrooster — en maakt daar een werkende Haven-applicatie van: een AI-agent schrijft de code, die wordt op het web gepubliceerd op een eigen adres, en Haven biedt die aan om te installeren. Aan jouw kant komt er geen programmeren bij, en wat eruit komt is een echte applicatie en geen demo.

Je installeert hem net als al het andere uit de Haven App Store. De eerste keer dat je hem gebruikt, vraagt hij je drie accounts te verbinden, en dat is het enige technische deel van het hele verhaal. GitHub bewaart de broncode van de app, Cloudflare publiceert die, en Cursor levert de AI die de code schrijft. GitHub en Cloudflare verbinden elk met één klik via hun eigen toestemmingsscherm, zonder dat je ergens een account-ID of eigenaarsnaam moet opzoeken. Cursor heeft geen toestemmingsflow, dus daar plak je een API-sleutel uit het dashboard — en de cloudagents die de builder start zitten niet in het gratis plan van Cursor. Dat is ook de enige die je kunt uitstellen: zonder Cursor-sleutel wordt het project nog steeds aangemaakt en gepubliceerd, het komt alleen leeg aan.

Vanaf dan is een app bouwen een naam, één zin over het doel, en een korte opdracht die beschrijft wat de app moet doen, geschreven in gewone taal in plaats van in technische termen. Op de knop drukken zet vier dingen in gang. Het project wordt aangemaakt vanuit de officiële startsjabloon, die de documentatie van de App SDK en een gids met best practices al bij zich heeft, zodat de agent werkt vanuit de interfaces die echt bestaan in plaats van ernaar te gokken. De app krijgt een eigen webadres, aangesloten op de buildpijplijn van Cloudflare, zodat elke latere push die zelf opnieuw uitrolt. Een cloudagent pikt de opdracht op en begint te schrijven, en genereert onderweg een passend app-icoon. En wanneer die klaar is, geeft de builder de app aan Haven.

Je kunt het allemaal meekijken. Elke stap meldt wat die heeft gedaan, en het werk van de agent is zichtbaar terwijl het loopt, zodat je meekijkt en feedback geeft in plaats van op een zwarte doos te wachten. Dat kanaal blijft daarna open: om de volgende functie vragen is opnieuw een opdracht tegen hetzelfde project, en de agent pakt op waar die was gebleven.

Haven installeert het resultaat zoals het alles installeert. Het leest de eigen beschrijving van de afgeronde app en vraagt het eerst aan jou, met een overzicht van de databases, rechten en netwerktoegang die de nieuwe app wil. Zodra je goedkeurt, is het een tegel in je werkruimte zoals elke andere, klaar om schermvullend of ingesloten in de kaart te draaien.

Wat je aan het eind bezit is het waard om expliciet te benoemen. De code is een gewone Git-repository in je eigen GitHub-account, gebouwd op dezelfde App SDK die de first-party apps gebruiken, met het hele platform beschikbaar: databases, virtuele weergaven, offline werken, realtime synchronisatie, Havens thema. De AI is vervangbaar — zet Claude Code, Codex of je eigen handen op de repository, en Cloudflare publiceert opnieuw wat er ook binnenkomt, door wie het ook is geschreven. En omdat de app op een openbaar adres staat, kan een collega aan wie je de link stuurt dezelfde app aan zijn eigen Haven toevoegen.

De inloggegevens krijgen zorgvuldige behandeling, want er zijn er drie en ze zijn machtig. Ze staan in één document in je eigen App Builder-database, versleuteld voor jou persoonlijk, zodat een gedeelde database ze niet blootlegt en de volgende app er niet opnieuw om vraagt. Het GitHub-token verlaat het browsertabblad helemaal niet. Het Cloudflare-token en de Cursor-sleutel bereiken wel de server van de builder, voor de aanroepen die een browser niet mag doen, en er wordt daarna niets bewaard. Geen enkele inloggegeven wordt ooit aan de codeeragent gegeven: publiceren loopt via Cloudflares eigen Git-integratie, die geen tokenoverdracht nodig heeft, precies zodat een cloudmachine nooit iets krijgt waarmee die kan uitrollen.

De App Builder vraagt Haven om één ongebruikelijk recht, Apps voorstellen, en dat is wat hem toestaat de app die hij net heeft gebouwd aan te bieden in plaats van jou een URL met de hand te laten kopiëren. Hij moet ook pop-upvensters kunnen openen, omdat de toestemmingsschermen van GitHub en Cloudflare daarin binnenkomen. Haven vraagt het je nog altijd voordat er iets wordt geïnstalleerd, elke keer.

De builder is zelf open source, en de gehoste kopie is een gemak en geen vereiste. Wil je liever dat de Cursor-sleutel nooit langs een server komt die je zelf niet beheert, kloon dan [`mindoodb-app-builder`](https://github.com/klehmann/mindoodb-app-builder) en draai hem zelf; hij serveert op een loopbackadres, wat als beveiligde origin geldt, zodat een Haven op HTTPS hem nog steeds kan insluiten. Wijs Haven naar je eigen kopie met Nieuwe applicatie → Vanaf een URL in de App Store, met het loopbackadres dat hij bij het starten afdrukt, in plaats van de catalogusvermelding te installeren. Het is dezelfde applicatie, en de Cursor-sleutel verlaat je machine dan nooit.

## Synchronisatie

Synchronisatie is hoe de gegevens in je lokale replica's in de pas blijven met de server. Iedereen kan de databases synchroniseren waartoe hij al toegang heeft — je hoeft geen beheerder te zijn.

Het scherm toont elke gevolgde database in elke lokale replica die de actieve gebruiker kan zien. Rijen zijn per tenant gegroepeerd. Voor elke rij zie je bij welke server, tenant, replica en database die hoort, de richting van de synchronisatie (alleen verzenden, alleen ontvangen of beide), en het laatste synchronisatieresultaat. Op rijen die eerder minstens één keer zijn afgerond verschijnt een klein badge "eerder gesynchroniseerd", waardoor je makkelijk de databases opmerkt die nog nooit zijn opgehaald.

Een tenant die alleen op dit apparaat bestaat heeft geen rijen om te tonen, omdat er nog geen server is om tegen te synchroniseren. In plaats van die weg te laten, geeft Synchronisatie hem een eigen kaart met een knop Naar server overzetten, die dezelfde publicatiedialoog opent als Instellingen → Tenants. Dit is de gebruikelijke weg om van een tenant uit de installatiewizard een gedeelde tenant te maken: de kaart staat waar je toch al naar synchronisatie zou gaan zoeken, en hij verdwijnt zodra de tenant op een server staat en zijn databases als gewone rijen opduiken.

Er zijn drie manieren om een synchronisatie te starten. De knop Synchroniseren per rij ververst alleen die database. De knop Tenant synchroniseren (op de kop van elke tenant) ververst elke database in die tenant. De knop Alles synchroniseren bovenaan de pagina ververst alles in één keer. Terwijl een synchronisatie loopt, toont de statuskolom live voortgang, inclusief hoeveel batches al zijn overgedragen. Een groen vinkje betekent dat de rij zonder fouten is afgerond. Een rood badge betekent dat er iets is misgegaan; gebeurt dat, dan laat Haven de rij zoals die vóór de synchronisatie was, zodat je nooit met halfdoorgevoerde wijzigingen eindigt.

Alles synchroniseren is een gesplitste knop, en het uitklapmenu bevat één optie die het waard is om te vinden: Wijzigingen automatisch naar servers pushen. Staat die aan, dan stuurt Haven je wijzigingen omhoog terwijl je ze maakt in plaats van op de volgende handmatige synchronisatie te wachten, waarmee het grootste deel van "heb ik wel gesynchroniseerd?" uit een werkdag verdwijnt. Het dekt alleen de uitgaande helft, en het wordt per gebruikersidentiteit onthouden in plaats van per apparaat.

De inkomende helft heeft geen instelling nodig, want die staat altijd aan. Voor elke server en tenant met minstens één rij op ontvangen of op beide richtingen, houdt Haven een live changefeed open en luistert. Kondigt de server een wijziging aan in een database die je volgt, dan haalt Haven die een paar seconden later op via de gewone synchronisatie-uitvoering, zodat de rij dezelfde voortgang en hetzelfde groene vinkje toont als een synchronisatie die je zelf hebt gestart. Een aankondiging dwingt geen overdracht af: Haven vergelijkt eerst de heads, dus nieuws over iets dat je al hebt kost één goedkoop verzoek. Een weggevallen feed verbindt zichzelf opnieuw. Waar de feed wel van afhankelijk is, is waar synchronisatie altijd van afhankelijk is — het Haven-tabblad open en de actieve identiteit ontgrendeld — en rijen op alleen verzenden of uitgeschakeld blijven buiten beschouwing, omdat er van hen niets staat te wachten om binnen te komen. Over een gewone serververbinding arriveert de feed als server-sent events; over een Iroh-verbinding gebruikt die in plaats daarvan een Iroh-stream. Een server die te oud is om een changefeed aan te bieden krijgt er simpelweg geen, en zijn rijen blijven op handmatige synchronisatie staan.

Met beide helften op hun plek houdt een serververbinding zich in beide richtingen zelf actueel, en worden de handmatige synchronisatieknoppen waar je naar grijpt als je op een bepaald moment zekerheid wilt, in plaats van wat je gegevens verplaatst.

Er verschijnt een knop Stoppen terwijl een synchronisatie loopt. Die stuurt een coöperatief stopsignaal naar de lopende uitvoering. De huidige rij mag netjes afmaken of terugrollen, zodat je niet met half weggeschreven gegevens eindigt. Er is één waarschuwing die het waard is om te kennen: druk je op Stoppen terwijl een specifieke rij midden in de overdracht zit, dan kan die rij met slechts een deel van de nieuwe gegevens eindigen, waardoor de volgende leesactie recente en oude waarden kan mengen. Laat die rij na een stop opnieuw lopen voordat je een getal eruit vertrouwt.

Wanneer moet je synchroniseren? Het korte antwoord is: voordat je een getal vertrouwt dat je gaat delen. Synchroniseer voordat je een export uit een virtuele weergave genereert, voordat je een vergadering binnenloopt op basis van een dashboard, en elke keer dat het netwerk een tijd weg is geweest. Alles synchroniseren is altijd veilig — het haalt alleen nieuwe gegevens op en stuurt je wachtende wijzigingen weg; het verwijdert nooit werk dat je nog niet hebt vastgelegd.

Eén klein struikelblok: verwacht je een database in de wachtrij en staat die er niet, dan is de gebruikelijke oorzaak dat de gebruikersidentiteit die de replica bezit nog niet is ontgrendeld. Synchronisatie heeft de sleutels uit de lokale KeyBag nodig, en de KeyBag opent alleen zodra de actieve identiteit vanuit de bovenbalk is ontgrendeld.

### Peer-to-peer-synchronisatie zonder server

Synchronisatie hoeft helemaal niet via een server te lopen. Twee Haven-apparaten in dezelfde tenant kunnen direct gegevens uitwisselen, en dat blijkt in twee heel verschillende situaties uit te maken. De duidelijke is een serverstoring: het team werkt door en de gegevens blijven bewegen, omdat niets in het pad afhangt van een server die aan staat. De subtielere is gewoon schrijven. Twee mensen die samen door hetzelfde document lopen, kunnen rechtstreeks met elkaar synchroniseren terwijl ze werken en het afgeronde resultaat één keer naar de server sturen, in plaats van elke tussenstand erlangs te leiden.

Je start het vanuit het ⋮-menu op de kop van een tenant op de pagina Synchronisatie, onder Peer-to-peer-synchronisatie zonder server. De dialoog die opent heet Synchroniseren met een ander apparaat en toont de apparaten van die tenant — die van jou onder Je apparaten, die van alle anderen gegroepeerd per lid waarbij ze horen. Elke rij geeft het apparaatlabel, het Eindpunt, de Ondertekeningssleutel, en of het op dat moment Bereikbaar is. Kies er een en druk op Apparaat toevoegen.

Het apparaat aan de andere kant moet je verwachten. In Instellingen → Algemeen staat een kaart met de naam Synchronisatie tussen apparaten met een aanvinkvakje: Inkomende apparaatsynchronisatie accepteren. Dat aanzetten laat andere apparaten van deze tenant direct met dit apparaat synchroniseren — inclusief apparaten van andere leden, niet alleen die van jezelf. Daar horen twee voorwaarden bij. De luisteraar bestaat alleen zolang het Haven-tabblad open is, en de sessie moet ontgrendeld zijn; een tabblad dat bij de ontgrendeldialoog staat antwoordt wel, maar weigert te synchroniseren, en dat is precies wat Haven dan aan de andere kant terugmeldt.

Wat apparaten vindbaar maakt is een eindpunt-ID. Haven genereert er één per apparaat bij de eerste start en publiceert die in de gebruikersdirectory-database van de tenant, en dat is ook waar de dialoog Synchroniseren met een ander apparaat zijn lijst uit leest — daarom kan die je een leesbare gebruikersnaam en apparaatlabel tonen in plaats van een kale identificatie. Publiceren gebeurt of je inkomende synchronisatie accepteert of niet, en dat is bewust: het hele punt is dat apparaten elkaar nog kunnen vinden wanneer de server uit is en er niets nieuws gepubliceerd kan worden. De keerzijde is dat een apparaat alleen weet van peers waarvan het de directoryvermelding al heeft opgehaald, dus een tenant die op dit apparaat nooit is gesynchroniseerd heeft nog niemand om aan te bieden.

Onder water loopt dit op het Iroh-netwerk. In de browser bereikt Haven het andere apparaat via een Iroh-relay — een gevolg van wat een webpagina met het netwerk mag doen, geen ontwerpvoorkeur — terwijl een native Haven-build direct kan verbinden wanneer beide apparaten op hetzelfde netwerk zitten. Hetzelfde transport is beschikbaar tussen client en server, als de MindooDB-server is geconfigureerd om aan Iroh deel te nemen; [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) behandelt die kant van de opzet.

Dat client-servergeval is een tweede blik waard, want het verandert wat een server moet zijn. Via HTTP bereikt moet een server bereikbaar zijn: een hostnaam, een certificaat, en een poort die iets op internet mag openen. Over Iroh geldt daar niets van. De server kan in een netwerk staan dat niemand kan bellen — een machine thuis achter een NAT-router, zonder doorgestuurde poort — en Haven komt er nog steeds bij, omdat geen van beide kanten een inkomende verbinding hoeft te accepteren: ze vinden elkaar via een relay, die ze óf helpt een direct pad te openen óf het verkeer zelf draagt wanneer de router dat niet toestaat. In plaats van een `https://`-adres voer je de `iroh:`-locator in die de server bij het starten afdrukt, en de synchronisatie loopt zoals altijd, live changefeed inbegrepen. Een relay in het pad ziet niet meer dan de server: wat erlangs gaat is ciphertext, en de relay leert alleen dat twee eindpunten met elkaar praten.

Terwijl andere apparaten met dat van jou synchroniseren, krijgt de pagina Synchronisatie een paneel met de kop Inkomende peer-to-peer-synchronisatie met een aantal sessies, met per regel welk apparaat wat in welke richting heeft overgedragen. Het wordt bij het opnieuw laden gewist, en het is de plek om te kijken wanneer je wilt bevestigen dat een directe synchronisatie werkelijk heeft plaatsgevonden.

## Snelscan

De snelscan is een documentscanner die in Haven is ingebouwd, en die verandert een blad papier in een net bestand zonder dat er iets het browsertabblad verlaat. Open hem vanaf Start en hij verschijnt als overlay over de werkruimte in plaats van als scherm waar je weer uit terug moet navigeren.

Richt de camera op een pagina, of kies een afbeelding die je al hebt. Haven vindt de randen van het blad, corrigeert het perspectief zodat het resultaat op een scan lijkt en niet op een schuin genomen foto, en laat je daarna rechtzetten, bijsnijden en draaien. Kiest de automatische randdetectie de verkeerde rechthoek — een gebloemd tafelkleed doet dat — sleep dan de hoeken zelf of druk op Randen opnieuw detecteren om het nog eens te proberen. Pagina-voorinstellingen zoals A4 en Letter houden de uitvoer op een verstandige beeldverhouding.

Een scan hoeft geen enkel blad te zijn. Druk op Pagina toevoegen en leg de volgende vast, en ga door tot de stapel op is. Een filmstrip langs de rand toont de pagina's die je tot nu toe hebt en nummert ze; selecteer er een om die te draaien, of gooi die weg en leg de pagina nog eens vast. Een scan van meerdere pagina's komt eruit als één PDF, terwijl één pagina ook een PNG of een JPEG kan zijn. Er is ook een actie Tekst extraheren die OCR over de pagina laat lopen wanneer je de woorden wilt in plaats van het plaatje.

Het gebeurt allemaal in het browsertabblad. De snelscan werkt offline, er wordt niets naar een dienst geüpload om te verwerken, en de afbeelding verlaat het apparaat alleen via de download of het delen dat je zelf kiest.

Wat de snelscan niet doet, is het resultaat voor je opbergen. Hij heeft twee uitgangen — een downloadknop en het deelvenster van het systeem — en beide geven je een bestand; er wordt niets in een database geschreven. Wil je dat de scan in een document terechtkomt, start hem dan vanaf wat dat document bezit. De databasebrowser scant direct naar het document dat je open hebt, en een applicatie kan dezelfde scanner via de App SDK openen en het resultaat aan een van zijn eigen documenten hangen. Het is in alle drie de gevallen dezelfde scanner en dezelfde perspectiefcorrectie; alleen de laatste stap verschilt.

## Virtuele weergaven

Virtuele weergaven zijn het analytische vlak van Haven. Ze geven je een spreadsheetachtige boomstructuur die documenten filtert, categoriseert, sorteert en optelt over één database, meerdere databases of zelfs meerdere tenants. Zo beantwoord je vragen over je gegevens heen in plaats van alleen binnen één database.

Ze hebben een tweede taak die makkelijk te missen is: een weergave is een goede gegevensbron voor een applicatie. Een app een hele database geven is soms meer dan die nodig heeft en meer dan je wilt weggeven. Bouw een weergave die precies de documenten en kolommen blootlegt waarmee de app moet werken, koppel de app aan de weergave in plaats van aan de database, en de app krijgt wat die nodig heeft terwijl de rest buiten bereik blijft.

Het scherm Virtuele weergaven bestaat uit twee delen: bovenaan de catalogus met opgeslagen weergaven, en daaronder het buildercanvas dat opent wanneer je er een selecteert of aanmaakt. De catalogus biedt Nieuwe weergave, Weergave openen, Weergave bewerken, Weergave dupliceren en Weergave verwijderen, plus knoppen Importeren en Exporteren om weergavedefinities tussen omgevingen te verplaatsen. Elke rij toont de naam van de weergave en de gegevensbronnen.

Het buildercanvas is waar de weergave werkelijk wordt samengesteld. Bovenaan geef je de weergave een naam, een optionele beschrijving en een categorisatiestijl (bijvoorbeeld categorieën vóór documenten). Daaronder komt het gedeelte Bronnen, waar elke bron een origin-label krijgt (zodat rijen in het resultaat kunnen vertellen uit welke database ze komen) en aan een tenant en een database wordt verbonden. Onder Bronnen komt de kolommenlijst, waar je categoriekolommen, sorteerkolommen en totaalkolommen toevoegt, met de visuele builder voor de gangbare gevallen of met een klein stukje code in een sandbox voor geavanceerde berekeningen. Een live voorbeeld bouwt zich mee op terwijl je werkt, zodat je de uitwerking van elke wijziging direct ziet.

Elke bron kan uit een lokale replica of uit een live externe bron lezen. Bronnen uit de lokale replica zijn het snelst en werken offline; live bronnen halen voor het indexeren verse gegevens van de server op, wat langzamer is maar je de meest recente serverstand geeft. Eén weergave kan beide mengen. Gebruik standaard bronnen uit de lokale replica en zet er alleen individuele op live wanneer actualiteit zwaarder weegt dan snelheid.

Omdat een weergave miljoenen rijen kan omspannen, indexeert Haven die lokaal en incrementeel. Elke opgeslagen weergave heeft in deze browser zijn eigen gematerialiseerde index. Vanaf de kop van de weergave kun je de lopende indexeringstaak bij het volgende schone checkpoint pauzeren, hervatten vanaf waar die was gebleven, of helemaal opnieuw opbouwen. Pauzeren en hervatten dekken bijna elke situatie; opnieuw opbouwen is alleen nodig nadat je de kolommen of bronnen van de weergave hebt gewijzigd, omdat die wijzigingen de cache ongeldig maken. Opnieuw opbouwen gooit anders werk weg dat de cache had kunnen hergebruiken.

In de resultaatboom kun je categorieën uitklappen, in documenten duiken en met de aanvinkvakjes een selectie opbouwen. Een categorie selecteren selecteert impliciet elk zichtbaar onderliggend document eronder. Exporteren als .xlsx levert een echte .xlsx-werkmap: de bijbehorende categorierijen blijven boven de geselecteerde documenten staan en zowel de metadata van de bron als de berekende weergavekolommen gaan mee, zodat je het bestand rechtstreeks aan een tool buiten MindooDB kunt geven.

## Databasebrowser en DAG-verkenner

De databasebrowser is er om in één database te graven. Daar toon je documenten, blader je door de geschiedenis, vergelijk je twee willekeurige revisies naast elkaar en bewerk je de actuele. Het is het nuttigste scherm wanneer je gegevens aan het uitzoeken bent, controleert wat er is gewijzigd, of een bijlage uit een specifieke revisie haalt.

De documentenlijst heeft drie modi: Alle, Bestaand en Verwijderd. Het filtervak accepteert één ID, kommagescheiden ID's, of één ID per regel, wat handig is wanneer je een lijst ID's van een collega of uit een script hebt. Elke rij toont de huidige revisie plus een klein badge voor documenten die nog open geschiedenis hebben.

Op een document klikken klapt de volledige revisiegeschiedenis uit, nieuwste eerst. De geschiedenis bevat de actuele revisie, elke eerdere revisie, en waar die bestaat de verwijdergebeurtenis. Bij grote geschiedenissen laden de rijen in batches; scrollen binnen het uitgeklapte paneel haalt er meer bij.

Een vergelijking naast elkaar is een van de nuttigste trucs van de browser. Kies één geschiedenisrij voor het linkerpaneel en een andere voor het rechter, en Haven markeert precies welke velden zijn gewijzigd. De selectie wordt over de pagina gedeeld, dus je kunt twee revisies van hetzelfde document vergelijken, of twee volledig verschillende documenten. Dit is de eenvoudigste manier om te bevestigen wat een geautomatiseerde wijziging werkelijk heeft gedaan voordat je iets met de hand samenvoegt.

Bewerken is alleen toegestaan op de actuele revisie. Historische en verwijderde revisies blijven strikt alleen-lezen, met opzet — Haven laat je de geschiedenis niet overschrijven. Bijlagen kunnen echter uit elke revisie worden gedownload, inclusief verwijderde, zodat je een bestand kunt terughalen dat ooit was bijgevoegd en daarna weggehaald.

Elk paneel, filter en vergelijking is in de URL weerspiegeld, dus een bladwijzer of een gedeelde link brengt je terug naar dezelfde weergave.

Wanneer de simpele revisielijst niet genoeg is om uit te leggen wat er is gebeurd, open dan de DAG-verkenner. Dat is een grafische weergave van elke ondertekende levenscyclusvermelding die ooit op het document is toegepast. De tijd loopt van links naar rechts: elke knoop is één ondertekende vermelding, en de verbindingen tonen hoe vermeldingen op elkaar volgden. Er ontstaan takken wanneer twee mensen het document tegelijk hebben bewerkt, en die komen weer samen bij een samenvoegknoop wanneer de volgende synchronisatie hun werk bij elkaar bracht.

Elke knoop is gelabeld met het soort vermelding dat die vertegenwoordigt. Aanmaken markeert de allereerste vermelding van het document. Wijzigen is een gewone bewerking die velden of bijlagen heeft geraakt. Verwijderen is een grafsteenvermelding — de eerdere inhoud blijft bewaard, alleen de levenscyclusstatus verandert. Terugzetten haalt een verwijderd document weer op en verwijst naar de Verwijderen-vermelding die het ongedaan maakt. Snapshot-knopen zijn periodieke compactiesnapshots en zijn hier alleen-lezen; je kunt er niet op klikken om een aparte tak te materialiseren.

Met de muis over een knoop gaan toont wie de wijziging heeft gemaakt, wanneer, vanaf welk apparaat, en welke velden zijn geraakt. Op een knoop klikken die geen snapshot is, materialiseert het document zoals het op die tak stond en toont het resultaat in het paneel Gematerialiseerde status, samen met de bijlagen die op dat moment bestonden. Haven hergebruikt daarvoor een nabijgelegen snapshot of speelt de keten van vermeldingen opnieuw af vanaf de wortels van de tak, en het vertelt je welke van de twee het heeft gedaan. Een tweede paneel, Conflictanalyse, somt de conflictpaden op die aan de door jou geselecteerde vermelding hangen, want de Automerge-engine van MindooDB lost gelijktijdige bewerkingen op met een deterministische regel in plaats van te gokken.

Niets in de DAG-verkenner kan worden bewerkt. Het is een getrouwe, alleen-lezen vastlegging van de geschiedenis. Dat is ook wat het nuttig maakt voor compliance: elke knoop is ondertekend door de gebruiker die de wijziging heeft gemaakt, dus het is de bron van waarheid wanneer een controleur vraagt wie dit wanneer heeft gewijzigd.

## Instellingen

Instellingen is het ene scherm dat als tabbalk is opgebouwd in plaats van als één pagina. Het heeft zes tabbladen: Algemeen, Gebruikers-ID's, Tenants, Back-up, Herstellen en Statistieken. Alles op deze tabbladen leeft in deze browser, met een paar bewuste uitzonderingen: de acties in Tenants, de optionele instelling Meereizende werkruimte, en het eindpunt dat Synchronisatie tussen apparaten publiceert zodat andere apparaten dit apparaat kunnen vinden.

### Algemeen

Algemeen is waar je aanpast hoe Haven eruitziet en hoe het op je apparaat start. Het is allemaal persoonlijk en werkt direct — er is geen knop Opslaan.

Bovenaan stelt Weergavetaal de taal in die Haven zelf spreekt — zijn navigatie, instellingen, dialogen en hulp. Het raakt je documenten niet, en applicaties die binnen Haven draaien brengen hun eigen vertalingen mee.

Met Huidig thema kies je een kleurvoorinstelling (bijvoorbeeld Mindoo of Aura) en wissel je tussen lichte en donkere modus. De voorinstelling wijzigt de accentkleuren in de hele app; de licht/donker-schakelaar bepaalt de achtergrond en het tekstcontrast. Dezelfde themakeuze wordt weerspiegeld in het rechtsklikmenu van de identiteitschip en wordt live doorgegeven aan elke ingesloten MindooDB-app, zodat die bij Havens uiterlijk past zonder opnieuw te laden.

Haven aan je beginscherm toevoegen is een kaart met één tik die je een snelkoppeling naar de installatiegids voor je platform biedt. Op de iPhone linkt die naar de flow "Zet op beginscherm" van Safari; op Android activeert die de prompt Installeren van de browser of wijst die je naar de actie Installeren in het browsermenu. Draait Haven al vanaf zijn geïnstalleerde icoon, dan bevestigt de kaart dat simpelweg en toont een knop Installatiestappen bekijken voor het geval je nog een kopie wilt toevoegen.

Een schakelaar Optimaliseren voor iOS-multitasking vertelt Haven dat het in de gesplitste weergave of slide-over van de iPad wordt gebruikt, waar het systeem vensterbedieningen toevoegt die Havens eigen chroom overlappen. Die aanzetten schuift Havens bedieningselementen daarvan weg. Onder Bewegingen haalt Animaties verminderen Havens overgangen eruit voor wie ze storend vindt of wiens systeem al om minder beweging vraagt.

Synchronisatie tussen apparaten is waar de ontvangende helft van de peer-to-peer-synchronisatie woont. Het aanvinkvakje is Inkomende apparaatsynchronisatie accepteren, en de kaart toont ook het eindpunt van dit apparaat — de identificatie die andere apparaten bellen om het te bereiken — samen met of iemand het op dat moment kan zien. De paragraaf over peer-to-peer-synchronisatie onder Synchronisatie legt uit wat de twee kanten doen; dit is de schakelaar die dit apparaat een van die twee maakt.

Meereizende werkruimte is de ene instelling op dit tabblad die de browser verlaat, en die staat uit tot je hem aanzet. Hij laat de werkruimtepagina's, tegels, groepen en de applicatielijst van de actieve gebruikers-ID met je meereizen naar je andere apparaten, en hij laat je meerdere omgevingen bijhouden en daartussen wisselen — kantoor en thuis, of desktop en mobiel. Het is een functie van Haven Enterprise: zonder actieve licentie blijft de schakelaar uit, bewaart dit apparaat zijn werkruimte niet en neemt het er ook geen over, en blijven omgevingen die je eerder hebt opgezet precies zoals ze zijn tot er weer een licentie is geïmporteerd. De schakelaar aanzetten laat twee velden zien: de tenant waarmee de werkruimte wordt gesynchroniseerd, en de naam van de opgeslagen werkruimte. De naam is hoe apparaten elkaar vinden, dus "kantoor" op je laptop en "kantoor" op je telefoon delen één werkruimte; het veld opent een uitklaplijst met de namen die al voor deze gebruikers-ID zijn opgeslagen, en een naam typen die niet in die lijst staat begint een nieuwe. Geen van beide velden wordt van kracht terwijl je eraan werkt — Toepassen legt beide vast, Annuleren zet terug wat van kracht is. Wat Toepassen doet volgt uit de naam: een nieuwe wordt aangemaakt uit de werkruimte van dit apparaat, een bestaande wordt overgenomen, en de tabbladen en tegels die hier zijn ingericht worden erdoor vervangen. Die vervanging kost je alleen iets wanneer meereizen uit stond, en dat is dus het enige geval waarover Haven eerst een vraag stelt; zodra meereizen aan staat, staat de stand van dit apparaat al in zijn opgeslagen werkruimte en is overstappen naar een andere naam gratis. De schakelaar uitzetten stopt het meereizen direct en laat elke opgeslagen werkruimte onaangeroerd.

Wat meereist is alleen de indeling: pagina's en hun volgorde, elke tegel met positie en grootte, groepen, de raster- en sorteerinstellingen, en je applicatieregistraties. Wat lokaal blijft is bewust weggelaten — welke pagina je op dit moment bekijkt, zodat een tweede apparaat je beeld niet kan wegtrekken. Apps die je tenantbeheerder via beleid uitrolt blijven ook buiten beeld, omdat elk apparaat die al uit de tenantdirectory krijgt.

De opgeslagen werkruimte is een gewoon MindooDB-document in de gebruikersdirectory van de tenant, versleuteld voor jou alleen — teamgenoten en beheerders synchroniseren de bytes ervan zoals al het andere en kunnen er geen woord van lezen, en alleen je eigen apparaten kunnen hem wijzigen of verwijderen. Omdat het een document is, reist het precies zoals je gegevens reizen: een wijziging wordt lokaal weggeschreven en bereikt het andere apparaat bij de volgende synchronisatie, dus beide apparaten moeten de server kunnen bereiken, niet elkaar, en geen van beide hoeft tegelijk open te staan. Twee apparaten die tegelijk bewerken voegen samen in plaats van overschrijven — hier een tegel verplaatsen terwijl daar een pagina wordt hernoemd houdt beide bewerkingen, en dezelfde tegel die op beide apparaten is versleept komt op één positie uit. Je kunt meerdere opgeslagen werkruimten per gebruikers-ID bijhouden, er per apparaat één volgen, en er vanaf dezelfde kaart een definitief verwijderen; apparaten die die volgden stoppen simpelweg met meereizen en houden de indeling die ze hebben. De lijst blijft zichtbaar met meereizen uitgeschakeld en dekt elke tenant die deze gebruikers-ID bereikt, dus elke vermelding noemt zijn tenant naast de naam van de opgeslagen werkruimte, en wanneer die het laatst is weggeschreven door welk van je apparaten dat ook deed — een werkruimte die maanden niemand heeft aangeraakt is makkelijk te herkennen voordat je die verwijdert.

### Gebruikers-ID's

Een gebruikersidentiteit is je account binnen Haven, en dit tabblad is waar je je opgeslagen identiteiten beheert. Elke rij is één identiteit met zijn gebruikersnaam, waarmee die ontgrendelt, en de aanmaakdatum; beheerdersidentiteiten zijn gemarkeerd met een label Beheerder zodat ze makkelijk van dagelijkse gebruikers te onderscheiden zijn. De actie Wisselen maakt die identiteit de actieve voor deze Haven-sessie — bij een passkey-identiteit is dat één knop en een Face ID-vraag in plaats van een getypt wachtwoord. Er is er maar één tegelijk ontgrendeld; klaagt iets op een ander scherm dat het een tenant niet kan lezen, dan is meestal de verkeerde identiteit ontgrendeld.

Aanmaken genereert een geheel nieuwe identiteit direct in de browser en biedt dezelfde keuze tussen passkey en wachtwoord als de welkomstwizard. Importeren haalt een .json-bestand binnen dat eerder uit Haven is geëxporteerd of door de MindooDB-console is gemaakt (bijvoorbeeld op een ander apparaat of door een teamgenoot) en vraagt om het wachtwoord dat bij het exporteren van het bestand is gebruikt.

De kolom Ontgrendelt met vertelt je welke geheimen een identiteit op dit moment openen, en één knop verandert dat: Aanmeldopties. Die herhaalt wat de geselecteerde identiteit vandaag opent en biedt daarna alleen de wijzigingen die daarbij passen: een identiteit die al een wachtwoord heeft krijgt geen tweede aangeboden, en een identiteit zonder passkey heeft er geen om te verwijderen, dus de lijst is twee of drie vermeldingen in plaats van een muur van uitgegrijsde knoppen. De uitzondering is een actie die wél bij de identiteit past maar die een regel verbiedt — die blijft in de lijst staan met de reden in plaats van de beschrijving, want de reden is meestal de weg vooruit. Een beheerdersidentiteit vertelt waarom die alleen een wachtwoord houdt, en Wachtwoord verwijderen bij een identiteit die nog geen passkey heeft zegt dat je er eerst een moet toevoegen in plaats van simpelweg te weigeren.

Passkey toevoegen registreert de authenticator van dit apparaat voor een identiteit die alleen een wachtwoord had; je wachtwoord blijft precies zoals eerder werken, dus dit is iets veiligs om op elk apparaat te doen dat je gebruikt. Passkeys verwijderen haalt de geregistreerde authenticators weer weg. Wachtwoord toevoegen doet het omgekeerde, en dat is vooral van belang voor exports: de console en de SDK draaien in Node, waar geen authenticator is om te vragen, dus een identiteit met alleen een passkey kan buiten deze browser niet worden geopend. Vraag je om een volledige export van een identiteit met alleen een passkey, dan grijst Haven de menu-optie niet uit — het vraagt eerst om een wachtwoord, voegt dat naast de passkey toe en schrijft dan het bestand. Er wordt daarbij niets opnieuw versleuteld; de identiteit krijgt simpelweg een tweede manier naar binnen.

Wachtwoord verwijderen is de optie om twee keer over na te denken. Het laat een identiteit achter die alleen zijn passkey opent, wat de sterkere opzet is — er is geen getypt geheim meer over om te phishen, te hergebruiken of te vergeten — maar het brengt ook de manieren terug naar binnen tot één terug. Haven weigert botweg zolang er geen passkey is geregistreerd, want een identiteit zonder ontgrendelmethode is onherstelbaar: de sleutel die de privésleutels opent bestaat alleen binnen die wrappers. Ook met een passkey op zijn plek: houd een versleutelde back-up. Een passkey die niet synchroniseert leeft in deze ene authenticator, en het back-upbestand is wat een verloren laptop verandert in "herstellen en het back-upwachtwoord typen" in plaats van in een verloren identiteit. Een volledige identiteitsexport blijft geblokkeerd zolang er geen wachtwoord is, om de Node-reden hierboven, en er weer een toevoegen is een dialoog met twee velden ver.

Wachtwoord wijzigen staat in dezelfde lijst. Bij een identiteit waarvan de ontgrendelmethoden wrappers rond een interne sleutel zijn — alles wat recent is aangemaakt, en alles wat ooit een passkey heeft gehad — vervangt Haven alleen de wachtwoordwrapper, zodat elke geregistreerde passkey geldig blijft en er geen KeyBag opnieuw opgebouwd hoeft te worden. Bij een oudere identiteit waarvan het wachtwoord de privésleutels direct versleutelt, versleutelt Haven die en de tenant-KeyBags die ervan afhangen in één stap opnieuw, zodat het nieuwe wachtwoord overal direct werkt. Kies in beide gevallen een sterk wachtwoord en bewaar het waar je het terugvindt, want er is geen herstellink: vergeet je het nieuwe wachtwoord, dan wordt elke tenant die aan deze identiteit hangt onleesbaar, ook op apparaten die de gegevens al hadden. Zet het in een wachtwoordmanager voordat je op Opslaan drukt.

Is een identiteit met een wachtwoord aangemaakt voordat passkeys bestonden, dan biedt Haven aan er de volgende keer dat je hem ontgrendelt een toe te voegen. Aanvaarden kost één Face ID-vraag en laat het wachtwoord als terugvaloptie staan. Wachtwoord blijven gebruiken is een definitief antwoord voor dit apparaat: Haven onthoudt het en vraagt het nooit meer voor die identiteit, en Aanmeldopties op dit tabblad blijft beschikbaar als je later van gedachten verandert. De dialoog met de X of Escape sluiten stelt de vraag alleen uit, zodat je bij de volgende ontgrendeling kunt beslissen. Een passkey weer verwijderen geldt ook als antwoord — Haven begint er daarna niet bij elke ontgrendeling een aan te bieden.

Onder de identiteitstabel toont Je apparaten, zodra een identiteit is ontgrendeld, elk apparaat dat de gebruikerssleutel van die persoon heeft — of erop wacht — met één rij per apparaat en tenant, en met een actie Goedkeuren of Toch toestaan waar je die mag gebruiken. Dit is het paneel achter de goedkeuringsprocedure die onder Haven op meer dan één apparaat gebruiken is beschreven, en de plek om heen te gaan wanneer je de goedkeuringsdialoog te snel hebt weggeklikt.

### Tenants

Een tenant is de privéwerkruimte van je team, en dit tabblad toont elke tenant die Haven kent voor de actieve gebruikersidentiteit. Voor elke rij zie je het tenant-ID, de huidige gebruiker, de beheerder, en eventuele servers waarnaar de tenant is gepubliceerd.

Een tenant openen toont de vingerafdrukken van zijn sleutels en waar die op dat moment is gepubliceerd. De vingerafdrukken komen uit de lokale KeyBag van de actieve gebruiker, dus ze verschijnen pas zodra die gebruiker is ontgrendeld. Behandel vingerafdrukken als identiteitsbewijs voor de versleutelingssleutels van de tenant: vergelijken twee teamleden ze in persoon en komen ze overeen, dan kun je er op vertrouwen dat er onderweg geen sleutel is verwisseld.

Acties die de tenantdirectory raken — een tenant publiceren, of een teamgenoot toegang verlenen vanuit een toegangsverzoek — worden door de beheerdersidentiteit ondertekend, dus Haven vraagt om diens wachtwoordzin. Omdat dat soort taken meestal in reeksen komen, biedt de vraag aan de beheerder voor deze sessie te ontgrendelen: vink dat één keer aan en de volgende stappen stoppen ermee te vragen. Een beheerder zo ontgrendelen wisselt je actieve identiteit niet, dus je dagelijkse gebruiker blijft degene die het documentwerk doet, en met Beheerder weer vergrendelen beëindig je het vroegtijdig wanneer je klaar bent.

Nieuwe tenants beginnen altijd in deze browser voor de actieve gebruiker. Publiceren zet de tenant op een MindooDB-server zodat andere teamleden kunnen toetreden; de pagina Synchronisatie biedt dezelfde stap als knop Naar server overzetten zolang een tenant nog alleen lokaal is, dus de meeste mensen komen die daar eerst tegen. Verwijderen van een server haalt alleen de tenantlocatie van die server weg — de lokale kopie blijft staan. Publiceren en verwijderen op een server vereisen een wachtwoord van een systeembeheerder, omdat ze gedeelde infrastructuur raken; ben je niet de platformbeheerder, vraag die dan om de actie samen met je uit te voeren.

Wees voorzichtig met verwijderen op de server. Het wist het beeld van die server op de tenant voor elke gebruiker, niet alleen voor jou, en andere clients kunnen plotseling niet meer synchroniseren. Bevestig het eerst met de platformbeheerder en eventuele andere teambeheerders, en zorg dat er een actuele versleutelde back-up bestaat voordat je op de knop drukt.

### Back-up

Haven houdt bijna alles in deze browser. Het tabblad Back-up is het veiligheidsnet, en het biedt twee heel verschillende netten: een versleuteld bestand dat alles bevat, en een papieren afdruk die één tenant uit het niets kan terugbrengen. Een van de twee terugzetten — en Haven wissen — gebeurt op het tabblad Herstellen ernaast.

Een versleutelde back-up is één bestand dat alles bevat wat Haven in deze browser bewaart: opgeslagen gebruikers, tenants, applicaties, gehoste app-bestanden, de indeling van de werkruimte, virtuele weergaven en de lokale IndexedDB-inhoud. Je kiest een back-upwachtwoord, en Haven gebruikt dat om het bestand te versleutelen voordat het wordt gedownload. Er is precies één back-upwachtwoord voor het hele bestand, hoeveel identiteiten er ook in zitten. Het wachtwoord zelf wordt nergens opgeslagen — Haven kan het je later niet tonen en kan je niet helpen de back-up terug te halen als je het kwijt bent. Downloads gebruiken de extensie .mdbhaven-backup, zodat ze makkelijk te herkennen zijn in een downloadmap.

Identiteiten die met een passkey ontgrendelen vragen één extra overweging, omdat een passkey het apparaat waarop die staat niet kan verlaten — dat is het hele punt van een passkey, en het is ook waarom herstellen op een nieuwe laptop je anders een identiteit zou geven die niemand kan openen. Haven lost dit binnen het bestand op in plaats van je apparaat zwakker te maken: voor elke identiteit met alleen een passkey voegt het een kopie van de ontgrendelsleutel toe die met je back-upwachtwoord opent. Je lokale identiteit blijft onaangeroerd en houdt zijn passkey. Zijn een of meer van die identiteiten op dat moment vergrendeld, dan vraagt Haven één keer om de passkey terwijl de download wordt voorbereid. Het praktische gevolg is dat het back-upwachtwoord net zoveel waard is als de identiteiten in het bestand: behandel het als een hoofdsleutel en bewaar het daarnaar.

De tweede kaart op het tabblad is de tenant-noodafdruk, en die antwoordt op een andere vraag: wat overleeft wanneer geen enkele browser dat doet. Die dekt één tenant per keer en bevat alleen wat niet opnieuw gedownload kan worden — de gebruikers- en beheerdersidentiteiten die je selecteert, hun KeyBag-sleutels, de server-URL en de synchronisatieopzet — zodat een latere synchronisatie de werkelijke documenten weer van de server kan halen. Hij bevat met opzet geen documentgegevens, wat ook betekent dat hij geen nut heeft voor een tenant die nooit is gepubliceerd. Je kiest een geheime vraag, die op het vel wordt afgedrukt, en een antwoord, dat dat niet wordt; het antwoord is wat het vel later ontsleutelt. Haven verdeelt de versleutelde inhoud vervolgens over acht QR-codes met genoeg redundantie dat willekeurige zes ervan volstaan, zodat een koffievlek of een afgescheurde hoek je de tenant niet kost. Bewaar hem waar je paspoorten bewaart, niet waar je afdrukken bewaart.

### Herstellen

Het tabblad Herstellen is waar een back-up terugkomt, en waar Haven gewist kan worden als niets anders meer helpt.

Een versleuteld back-upbestand herstellen gebeurt in twee stappen, beide met opzet. De eerste stap, Herstelvoorbeeld bekijken, ontsleutelt het bestand net genoeg om je een samenvatting te tonen van wat erin zit: aantallen identiteiten, tenants, applicaties, IndexedDB-databases, en eventuele herstelwaarschuwingen. Er wordt nog niets lokaal aangeraakt. Sommige back-ups bevatten databases die niet zoals ze zijn tussen browsers kunnen verhuizen; het voorbeeld toont per betrokken database een waarschuwing met of die leeg opnieuw wordt opgebouwd of wordt overgeslagen. Opnieuw opbouwen betekent dat de database leeg wordt aangemaakt en via synchronisatie weer wordt gevuld. Overslaan betekent dat die helemaal niet wordt hersteld en dat je die bron met de hand opnieuw moet verbinden.

De tweede stap, Herstellen en opnieuw laden, wist de huidige Haven-stand in deze browser en schrijft de back-up terug. Haven laadt automatisch opnieuw en je eindigt aangemeld bij de herstelde gegevens. Omdat herstellen eerst de huidige stand verwijdert, is alles wat niet is geëxporteerd en niet is gesynchroniseerd weg. Exporteer een verse versleutelde back-up van de huidige stand voordat je op Herstellen drukt, voor de zekerheid.

Na een herstel op een ander apparaat of in een andere browser vragen identiteiten die eerder met een passkey ontgrendelden in plaats daarvan om het back-upwachtwoord, en de ontgrendeldialoog vermeldt dat. De passkey is op het oude apparaat gebleven, dus dit is te verwachten en geen teken dat er iets fout is gegaan. Ontgrendel de identiteit één keer met het back-upwachtwoord en gebruik daarna Passkey toevoegen om de authenticator van het nieuwe apparaat te registreren; vanaf dat punt gedraagt de identiteit zich precies zoals eerder.

Herstellen vanaf een tenant-noodafdruk gebruikt de tweede kaart en dezelfde voorzichtigheid in twee stappen. Scan de QR-codes met de camera van het apparaat of plak de inhoud ervan, beantwoord de geheime vraag, en Haven zet de identiteiten, het KeyBag-materiaal, de server-URL en de synchronisatieopzet terug. Er reist niets anders op papier mee, dus voer daarna een synchronisatie uit om de documenten van de tenant weer op te halen. Dit is ook de weg terug wanneer elk goedgekeurd apparaat voor een tenant weg is en er niemand over is om een nieuw apparaat goed te keuren.

Fabrieksinstellingen staat onderaan het tabblad. Het wist alles wat Haven in deze browser kent — identiteiten, tenants, applicaties, gehoste app-bestanden, virtuele weergaven, de indeling van de werkruimte en alle gesynchroniseerde MindooDB-gegevens — en zet Haven terug in zijn spiksplinternieuwe staat. Omdat het onomkeerbaar is, vraagt Haven je een bevestigingszin te typen voordat de knop actief wordt, en vraagt het daarna de browser om nog een bevestiging. Behandel terugzetten naar fabrieksinstellingen als laatste redmiddel en alleen nadat er een bekend werkende back-up bestaat.

### Statistieken

Het tabblad Statistieken toont hoeveel ruimte Haven in deze browser gebruikt en laat je veilig ruimte vrijmaken. Browsers begrenzen hoeveel opslag één site mag gebruiken, dus begrijpen wat ruimte inneemt houdt Haven snel.

Een groot getal bovenaan telt alles op wat Haven op dat moment in deze browser bewaart: elke lokale database, elke cache, elk gehost app-bestand. Een knop Vernieuwen rekent het na grote bewerkingen zoals een synchronisatie, een verwijdering of een cachewissing opnieuw uit. De getallen verversen niet automatisch, omdat het meten van grote opslagen langzaam kan zijn. Ernaast maakt Onvolledige uploads opruimen de versleutelde blokken vrij die zijn achtergebleven van bijlage-uploads die nooit klaar kwamen; bijlagen die de documentgeschiedenis hebben gehaald, worden nooit aangeraakt.

Onder het totaal toont een gedeelte per tenant één blok per tenant. Elke tenantkop heeft de gecombineerde grootte plus een knop Cache wissen die alleen de opnieuw op te bouwen delen weghaalt — caches en indexen die Haven de volgende keer dat je de tenant gebruikt weer vult. Cache wissen verwijdert geen documenten of bijlagen.

Binnen elke tenant is elke rij één lokale database. Documenten is de versleutelde documentinhoud, Bijlagen is versleutelde bijlagebrokken, en Totaal is de som van de twee. Verwijderen wist de lokale inhoud van die database alleen in deze browser — de serverkopie blijft onaangeroerd. De beschermde directory-database kan niet worden verwijderd, omdat Haven die nodig heeft om te werken. Open voordat je verwijdert de database en voer een synchronisatie uit; zijn er niet-gesynchroniseerde lokale wijzigingen, dan raakt verwijderen die kwijt. Kies Cache wissen wanneer je alleen ruimte wilt vrijmaken, want dat is omkeerbaar.

Onder de databases van elke tenant zie je ook zijn caches: een lokale tenantcache voor algemene status per tenant, een serverdoelcache voor elke MindooDB-server waarmee de tenant praat, een cache van de virtuele weergave voor elke opgeslagen weergave, en een vermelding Full-text-index (MiniSearch) voor elke database waarvoor full-text-indexering aanstaat. Elke cache toont zijn eigen grootte, en caches van virtuele weergaven kunnen afzonderlijk worden gewist als één bepaalde weergave te groot is geworden.

Een blok Globale caches onderaan dekt gedeelde Haven-caches die buiten één tenant leven, zoals de service-workercaches voor gehoste apps. Die hebben dezelfde grootte-uitlezing als de caches op tenantniveau.

## Haven op een telefoon installeren

Haven is een progressive web app, wat betekent dat elke moderne mobiele browser het kan installeren alsof het een native app was. Eenmaal geïnstalleerd opent het in standalone-modus, zonder de adresbalk of tabbladenstrook van de browser, wat schoner is en je meer schermruimte geeft.

Op de iPhone en iPad open je Haven in Safari en tik je op de knop Delen — het icoon dat lijkt op een vierkant met een pijl naar boven. Scroll het deelvenster tot je Zet op beginscherm ziet en tik daarop. iOS heeft het icoon en de naam van Haven al, dus die vult het voor je in. Bevestig de naam, tik op Voeg toe, en er verschijnt een Haven-icoon op je beginscherm.

iOS heeft een leuke bonus: je kunt Haven meer dan één keer aan het beginscherm toevoegen. Elke geïnstalleerde kopie krijgt zijn eigen privéopslag op het apparaat, dus de gegevens in de ene kopie zijn volledig los van die in de andere. Dit is een prima manier om verschillende werelden op dezelfde iPhone gescheiden te houden — één kopie voor persoonlijke notities, één voor werk, één voor demo's — zonder ooit in en uit te loggen. Wijzig voordat je de tweede keer op Voeg toe tikt de voorgestelde naam (bijvoorbeeld naar Haven - Werk), zodat de iconen op het beginscherm makkelijk van elkaar te onderscheiden zijn. Elke kopie begint leeg en heeft zijn eigen gebruikersidentiteit, tenants en gesynchroniseerde databases nodig. Let op: versleutelde back-ups zijn ook per kopie — herstel een back-up in dezelfde kopie waaruit je hem hebt geëxporteerd, anders overschrijf je een andere omgeving.

Op Android open je Haven in een moderne browser zoals Chrome of Edge. Toont Haven een knop Installeren, accepteer die dan en je browser voegt Haven in één stap toe aan het beginscherm en de app-lade. Is er geen prompt, open dan het browsermenu (meestal drie puntjes in de hoek) en kijk naar Installeren of Zet op beginscherm — verschillende browsers verwoorden het anders, maar het resultaat is hetzelfde. Bevestig de prompt van de browser en Haven verschijnt op het beginscherm als een normaal Android-app-icoon.

Start Haven na het installeren op een telefoon altijd vanaf het icoon op het beginscherm — dat is een merkbaar prettigere ervaring dan een browsertabblad.

## Het beveiligingsmodel in één oogopslag

Wil je Haven in één minuut aan iemand uitleggen, dan is dit de samenvatting.

Elke gebruiker heeft een cryptografische identiteit, opgebouwd uit een Ed25519-ondertekeningssleutel en een RSA-OAEP-versleutelingssleutel. Beide privésleutels zijn versleuteld met een geheim dat alleen jij hebt, lokaal in de browser opgeslagen, en worden nooit verzonden. Die identiteit is wat tenants ontgrendelt en je wijzigingen ondertekent.

Het geheim kan een wachtwoord of een passkey zijn, en beide komen op dezelfde plek uit. Haven geeft elke identiteit één interne willekeurige sleutel die de privésleutels versleutelt, en pakt die sleutel daarna één keer per ontgrendelmethode in: een wachtwoordwrapper afgeleid met PBKDF2, en een passkeywrapper afgeleid uit de WebAuthn-PRF-extensie. Een ontgrendelmethode toevoegen of verwijderen voegt alleen een wrapper toe of haalt die weg, en dat is waarom je beide tegelijk kunt hebben en waarom geen van beide ooit het geheim van de ander leert. Datzelfde mechanisme is wat een YubiKey laat werken: voor WebAuthn zijn een security key en een ingebouwde Face ID-sensor hetzelfde soort authenticator, dus Haven sluit roaming keys niet uit — kies een YubiKey als je wilt dat het ontgrendelgeheim op iets leeft dat je in een lade kunt leggen in plaats van op de laptop zelf. Wat niet bestaat is een kopie in de cloud: er wordt niets in bewaring gegeven bij MindooDB, bij Apple of bij je browserleverancier, en een passkey wordt niet in een iCloud- of Google-apparaatback-up gesynchroniseerd in een vorm die Haven zou kunnen terughalen. Dat is de bewuste afweging — geen server kan worden gedwongen je gegevens te ontgrendelen, en geen server kan je helpen als je elk geheim kwijt bent dat je had. Je versleutelde back-upbestand is het herstelverhaal, en daarom is het tabblad Back-up niet optioneel.

Elke tenant heeft een KeyBag — een versleutelde opslag van versleutelingssleutels, geopend door de identiteit die er eigenaar van is. De standaardsleutel wordt met elk lid van de tenant gedeeld en versleutelt documenten tenzij er een specifiekere sleutel is gekozen. Benoemde sleutels geven fijnmazige toegang aan een kleinere groep voor bijzonder gevoelige documenten. Dit alles leeft op je apparaat; de server ziet nooit sleutels.

Elk document is een Automerge CRDT die in een content-geadresseerde opslag staat. Elke wijziging wordt met je Ed25519-sleutel ondertekend en met AES-256-GCM versleuteld voordat die ooit de browser verlaat. De server bewaart en doorgeeft ciphertext en kan je gegevens nooit lezen, zelfs niet als die volledig is gekraakt. Het transport voegt een tweede laag RSA-OAEP-versleuteling per gebruiker toe, en TLS legt daar als derde laag het geheel omheen. Toegangscontrole wordt via versleuteling gehandhaafd, wat betekent dat een document zonder de sleutel simpelweg ciphertext is — er is geen vertrouwde server om om toestemming te vragen en die om de tuin te leiden.

Omdat elke wijziging wordt ondertekend en aan een keten wordt toegevoegd, kan de geschiedenis niet stil worden herschreven. Havens DAG-verkenner is een directe weergave van die keten, en Automerge voegt gelijktijdige bewerkingen deterministisch samen, zodat twee mensen aan hetzelfde document kunnen werken zonder conflictdialoog.

Apps die binnen Haven draaien zijn ingepakt in de sandbox van de browser, op hun eigen origin. Gehoste apps krijgen een nog strengere sandbox met een opaque origin. Een app kan niet bij Havens opslag, cookies of andere apps komen; die ziet alleen de databases die je hebt gekoppeld en de rechten die je hebt gegeven. Elke aanroep die de app doet — lezen, schrijven, bijlagen, geschiedenis — loopt via Havens SDK-bridge, die die tegen de koppeling valideert voordat er gegevens worden aangeraakt. Gehoste apps kunnen ook het internet niet bellen tenzij je de URL hebt vermeld; de standaard is weigeren. Het volledige model, de resterende risico's en het verschil met apps die in een MindooDB-database zijn opgeslagen staan in [hosted-app isolation](hosted-app-isolation.md).

Dat is, in een minuut, waarom Haven privé is door ontwerp en niet door beleid.

## Begrippenlijst

Dit zijn de begrippen die Haven op zijn schermen en in zijn hulplade gebruikt. Ze staan ruwweg in de volgorde waarin je ze waarschijnlijk tegenkomt, niet strikt alfabetisch, omdat de meeste voortbouwen op de voorgaande.

Gebruikersidentiteit — je account binnen Haven. Lokaal aangemaakt, beschermd door een passkey of een wachtwoord, en is wat tenants ontgrendelt en je wijzigingen ondertekent. Het tabblad in Instellingen heet Gebruikers-ID's.

Passkey — een ontgrendelmethode op basis van de authenticator van je apparaat: Face ID, Touch ID, Windows Hello, of een security key zoals een YubiKey. Haven leidt de sleutel die je privésleutels opent er lokaal uit af, zodat het geheim het apparaat nooit verlaat en nooit naar een server wordt gestuurd.

Wachtwoordzin — meerdere willekeurige woorden in plaats van een wachtwoord. Haven biedt een gegenereerde wachtwoordzin van zes woorden aan voor beheerdersidentiteiten, omdat die zowel sterker is dan een doorsnee getypt wachtwoord als makkelijk op te schrijven; zelf een wachtwoord typen blijft beschikbaar.

Tenant — de privéwerkruimte van je team binnen MindooDB. Bundelt gebruikers, versleutelingssleutels en databases zodat een team veilig gegevens kan delen.

Tenantlabel — de door mensen leesbare naam van een tenant. Haven genereert het tenant-ID zelf en dat verandert nooit; het label is het deel dat jij kiest, en een beheerder kan dat hernoemen zodra het niet meer past.

Tenantbeheerder — een identiteit met extra rechten binnen een tenant. Kan andere gebruikers registreren of intrekken en tenantbrede instellingen wijzigen.

App-gebruiker — een gewone gebruikersidentiteit binnen een tenant. Doet het dagelijkse documentwerk, maar kan geen andere gebruikers registreren of intrekken.

Systeembeheerder — een identiteit op serverniveau, gebruikt om een MindooDB-server zelf te beheren: Haven eraan verbinden, andere servers vertrouwen, en nieuwe tenants opstarten.

KeyBag — een lokale, versleutelde sleutelopslag met de versleutelingssleutels die een tenant nodig heeft, geopend door de identiteit die er eigenaar van is. Elke gebruiker houdt de zijne in deze browser.

Standaardsleutel — de versleutelingssleutel die met elk lid van een tenant wordt gedeeld. Geeft een document geen benoemde sleutel op, dan wordt het met de standaardsleutel versleuteld.

Benoemde sleutel — een extra versleutelingssleutel die alleen met geselecteerde gebruikers wordt gedeeld. Nuttig voor gevoelige documenten die niet voor de hele tenant zichtbaar moeten zijn.

Gebruikerssleutel — een versleutelingssleutelpaar dat bij een persoon hoort en niet bij een apparaat of een tenant. De openbare helft wordt in de tenant gepubliceerd zodat anderen voor je kunnen versleutelen (zo bereikt de standaardsleutel je); de privéhelft leeft alleen op de apparaten die je hebt goedgekeurd. Eén gebruikerssleutel per persoon, één ingepakte kopie per goedgekeurd apparaat.

Apparaatgoedkeuring — de stap waarmee een nieuwe browser of telefoon de documenten van een tenant kan lezen. Een al goedgekeurd apparaat schrijft een kopie van je gebruikerssleutel voor de nieuwkomer; tot dat gebeurt kan het nieuwe apparaat ciphertext synchroniseren maar niet openen. Goedkeuring moet altijd komen van een apparaat dat al is goedgekeurd.

Tenant-noodafdruk — een afdrukbaar vel met redundante QR-codes voor één tenant, met identiteiten, KeyBag-sleutels en de server- en synchronisatieopzet, maar geen documenten. Gemaakt op het tabblad Back-up, hersteld op het tabblad Herstellen, en de enige weg terug wanneer elk goedgekeurd apparaat weg is.

Ondertekende wijziging — elke bewerking van een document wordt met de privésleutel van de auteur ondertekend. Dat bewijst wie de wijziging heeft gemaakt en voorkomt dat iemand later geschiedenis vervalst.

Lokale replica — een in de browser opgeslagen, gesynchroniseerde kopie van de databases van een tenant. Snel, werkt offline, en de aanbevolen manier om te bladeren en te bewerken.

Live bron — een bronmodus die verse gegevens van een MindooDB-server ophaalt voordat die worden gebruikt. Langzamer dan de lokale replica, maar nuttig wanneer je de allerlaatste stand nodig hebt.

Changefeed — de stroom waarmee een server nieuwe schrijfacties aankondigt aan de clients die erop luisteren. Haven houdt er één open per server en tenant waaruit het ophaalt, en dat is wat inkomend werk vanzelf laat aankomen. Staat altijd aan; heeft geen eigen instelling.

Peer-to-peer-synchronisatie — een directe synchronisatie tussen twee apparaten van dezelfde tenant, zonder server in het pad. Loopt over het Iroh-netwerk. Op het ontvangende apparaat moet Inkomende apparaatsynchronisatie accepteren aan staan, en het tabblad open en ontgrendeld zijn.

Eindpunt — het adres waarop een apparaat voor peer-to-peer-synchronisatie wordt gebeld. Haven genereert er één per apparaat en publiceert die in de gebruikersdirectory van de tenant, zodat apparaten elkaar nog kunnen vinden terwijl de server onbereikbaar is.

Iroh — het netwerk dat Haven gebruikt wanneer er geen bereikbaar adres is om mee te verbinden. Het draagt peer-to-peer-synchronisatie tussen twee apparaten, en het kan ook gewone client-serversynchronisatie dragen naar een MindooDB-server die eraan deelneemt — bijvoorbeeld een server achter een NAT-router, zonder doorgestuurde poort en zonder certificaat. Beide kanten ontmoeten elkaar via een relay, die ziet dát ze praten maar niet wát ze zeggen.

Snelscan — Havens ingebouwde documentscanner. Vindt de randen van een pagina, corrigeert het perspectief en neemt zoveel pagina's als je nodig hebt in één scan mee. Draait volledig in het browsertabblad, offline inbegrepen. Het geeft het resultaat als bestand af — een PDF van meerdere pagina's, of een PNG of JPEG voor één pagina — via een download of het deelvenster van het systeem; een scan aan een document hangen doe je vanuit de databasebrowser of door een app via de App SDK.

IndexedDB — de ingebouwde database van de browser. Haven slaat bijna alles in IndexedDB op zodat het offline kan werken.

Gegevensbytes — een benadering van hoeveel echte inhoud Haven in deze browser bewaart. Het laat de overhead buiten beschouwing die de browser zelf toevoegt.

Lokale tenantcache — een browsercache per tenant die Haven helpt werk sneller te heropenen, synchronisatie te hervatten en lokale querygegevens te hergebruiken. Kan worden gewist en wordt automatisch opnieuw opgebouwd.

Serverdoelcache — een cache beperkt tot één tenant en één server. Versnelt live synchronisatie tegen die server en kan veilig worden gewist.

Cache van de virtuele weergave — bewaart de gematerialiseerde resultaten van een virtuele weergave plus de hervatbare indexeringsstatus, zodat de weergave snel heropent. Die wissen bouwt de weergave de volgende keer dat je hem opent opnieuw op.

Beschermde database — een database die Haven nodig heeft om te werken (bijvoorbeeld de tenantdirectory). Die kan niet uit het opslagpaneel worden verwijderd.

Start — het vaste eerste tabblad van de werkruimte. Draagt Havens zes snelkoppelingstegels en één tegel per geïnstalleerde applicatie. Het kan niet worden herschikt; je eigen tegels gaan op de pagina's ernaast.

Tegel — een versleepbare, vergrootbare kaart op het raster van de werkruimte. Elke tegel bevat een database, een applicatie, een notitie, een ingesloten webpagina, een video of een diagram. Ook chicklet genoemd.

Pagina — een tabblad in de werkruimte met zijn eigen raster van tegels. Gebruik meerdere pagina's zoals beginschermen op een smartphone.

Groep — een visuele container die gerelateerde tegels onder een gedeelde, kleurgecodeerde kop clustert. Sleep de ene tegel op de andere om een groep te maken.

App-lade — het paneel achter het pijlgreepje bovenaan het inhoudsgebied. Toont de Haven-schermen die je open hebt en de applicaties die op dat moment draaien, met boven beide een weg terug naar de werkruimte. Cmd+Shift+Space opent hem en Cmd+Shift+Enter brengt je terug naar de werkruimte; druk op Windows en Linux op Ctrl in plaats van Cmd.

Database — een verzameling gerelateerde documenten binnen een tenant. Een tenant kan veel databases hebben (bijvoorbeeld contacten, facturen, notities).

Directory-database — een speciale beschermde database in elke tenant die gebruikersregistraties en tenantbrede instellingen bewaart.

Document — één stuk gegevens binnen een database. Op dit apparaat versleuteld voordat er wordt gesynchroniseerd, zodat de server alleen ooit ciphertext ziet.

Revisie — een versie van een document op een bepaald moment. Elke wijziging maakt een nieuwe revisie; oudere revisies blijven leesbaar zolang de geschiedenis wordt bewaard.

Bijlage — een bestand dat aan een document is gehangen. Opgeslagen in versleutelde brokken en op aanvraag gestreamd.

Automerge — de conflictvrije samenvoegengine die MindooDB onder water gebruikt. Twee mensen kunnen hetzelfde document tegelijk bewerken en Automerge voegt hun wijzigingen automatisch samen.

DAG-verkenner — een grafische weergave van elke wijziging die ooit op een document is toegepast, inclusief hoe gelijktijdige bewerkingen zijn samengevoegd.

Virtuele weergave — een spreadsheetachtige boomweergave over je documenten die filtert, categoriseert, sorteert en optelt. Kan uit één database, meerdere databases of zelfs meerdere tenants trekken.

Origin — een identificatie die aangeeft uit welke database (of tenant) een rij in een virtuele weergave komt. Nuttig wanneer één weergave meerdere bronnen combineert.

Gematerialiseerde index — de voorberekende resultaten van een weergave, in deze browser opgeslagen zodat een virtuele weergave direct kan worden heropend.

Haven App Store — de catalogus met kant-en-klare MindooDB-applicaties, geopend vanaf Start. Een vermelding installeren schrijft de registratie voor je en zet de app op Start.

App Builder — de app in de store die andere apps bouwt. Je beschrijft wat je nodig hebt; hij maakt de repository aan, publiceert de app, laat een AI-agent die schrijven, en geeft die aan Haven om te installeren. Het resultaat is een gewone MindooDB-app met broncode in je eigen GitHub-account.

Applicatieregistratie — de aan Havens kant opgeslagen definitie van een MindooDB-app: waar die vandaan wordt gestart, hoe die draait, en welke databases of weergaven die mag zien.

Gehoste bundel — een gebundelde set webassets die in Haven wordt geïmporteerd zodat het de app lokaal kan serveren, ook offline.

Externe URL — een webadres voor een app die buiten Haven wordt gehost, zoals een lokale ontwikkelserver of een uitgerolde webapp.

App-connector (bridge) — het beveiligde kanaal tussen een MindooDB-app en Haven. Apps praten nooit direct met je gegevens; elke lees- of schrijfactie loopt via deze connector zodat Haven de rechten die je hebt gegeven kan handhaven.

Startcontext — de eerste informatie die een app bij het starten van Haven ontvangt: thema, viewport, huidige gebruiker, startparameters, en de databases die eraan zijn toegekend.

Runtimemodus — hoe een geregistreerde app wordt gestart: ingesloten in het Haven-venster, of geopend in een eigen browsertabblad. Los van de weergavemodus van een tegel, die bepaalt of de tegel een launcher is waarop je dubbelklikt of de app in de kaart zelf draait.

Sandbox — de door de browser gehandhaafde isolatie die elke app omhult. De app kan niet bij Havens opslag, cookies of andere apps komen, tenzij je expliciet gegevens ermee deelt.

Themavoorinstelling — een benoemd kleurenpalet voor Haven (bijvoorbeeld Mindoo of Aura). De voorinstelling wisselen wijzigt de accentkleuren in de hele app.

Lichte / donkere modus — of Haven een lichte of donkere achtergrond gebruikt. De keuze wordt alleen in deze browser onthouden.

Standalone-modus — een weergavemodus waarin Haven start zonder de normale browserbediening, als een eigen app. Beschikbaar nadat je Haven aan het beginscherm van een telefoon hebt toegevoegd.

Zet op beginscherm — de browseractie die Haven als startbaar icoon op het beginscherm van een telefoon of tablet opslaat.

Installatieprompt — het browsereigen venster dat het toevoegen van een progressive web app zoals Haven aan het apparaat bevestigt.

Versleutelde back-up — één bestand met alles wat Haven in deze browser bewaart, versleuteld met een wachtwoord dat je zelf kiest. Zonder dat wachtwoord is het bestand onleesbaar.

Back-upwachtwoord — het ene wachtwoord waarmee een back-upbestand wordt versleuteld en later ontsleuteld, waarmee de identiteiten erin ook ontgrendelen. Het opent ook elke identiteit met alleen een passkey die uit dat bestand op een nieuw apparaat wordt hersteld. Haven slaat het nooit op; ben je het kwijt, dan kan de back-up niet worden hersteld.

Herstelvoorbeeld — een veilige stap die een back-upbestand net genoeg ontsleutelt om je te tonen wat erin zit, voordat er lokale gegevens worden aangeraakt.

Herstelwaarschuwing — een opmerking die tijdens het voorbeeld verschijnt wanneer een back-up databases bevat die bij het herstellen leeg opnieuw moeten worden opgebouwd of moeten worden overgeslagen.

Fabrieksinstellingen — wist alle Haven-gegevens uit deze browser, inclusief identiteiten, tenants, applicaties, gehoste apps, virtuele weergaven en gesynchroniseerde MindooDB-gegevens. Kan niet ongedaan worden gemaakt.

## Edities, prijzen en het open platform

Haven komt in twee edities, en die welke de meeste mensen ooit nodig hebben is gratis.

Haven Community is de gratis editie van Haven, in bèta, vandaag beschikbaar op [haven.mindoodb.com](https://haven.mindoodb.com). Het is dezelfde client die het MindooDB-team ontwikkelt, uitrolt en intern gebruikt. "Bèta" betekent hier dat het bruikbaar is voor echt werk, geen mockup — het ontwikkelt zich actief, feedback gaat direct de roadmap in, en er is nog geen formele SLA. Heb je gegarandeerde reactietijden nodig, dan is de commerciële supportlaag daarvoor.

Haven Community werkt in drie uitrolvormen. Alleen lokaal, waarbij alles in je browser leeft en er helemaal geen server is — perfect voor persoonlijke notities en offline demo's; in deze modus dient het tabblad Instellingen → Back-up ook als je overdrachtsmechanisme, want een versleuteld `.mdbhaven-backup`-bestand bevat je gebruikersidentiteiten, instellingen en MindooDB-databases, zodat je een volledige lokale Haven van de ene browser naar de andere kunt verplaatsen door te exporteren en te herstellen. Verbonden met de gehoste Mindoo-demoserver, waarmee je een lokale tenant kunt publiceren en echte samenwerking met meerdere gebruikers kunt testen; gegevens op de demoserver worden periodiek gewist, dus die is voor evaluatie en niet voor productie. En zelf gehost, waarbij je Haven naar een MindooDB-server wijst die je zelf draait, met volledige installatie-instructies in [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) in de MindooDB-repository. De keuze is aan jou en je kunt altijd tussen de vormen bewegen.

Haven Community is ook een volledig platform voor eigen appontwikkeling. Je kunt MindooDB-apps met de hand bouwen met de App SDK, of een AI-agent ze laten genereren uit de gestructureerde `llms-full.txt` op mindoodb.com plus de openbare referentie-app-repositories. De Haven App Store komt met een catalogus van afgeronde apps die je met één klik kunt installeren, zowel om te gebruiken als om te zien hoe een verzorgde MindooDB-app eruitziet. Mindoo Vega rendert dezelfde boom van knopen als mindmap, kanbanbord, ganttdiagram of spreadsheet, met taakvelden, bijlagen, tijdreizen door de documentgeschiedenis en full-text search — handig voor projectplanning waar dezelfde gegevens het ene moment een overzicht op hoofdlijnen en het volgende een baan-voor-baan- of datum-voor-datumbeeld nodig hebben. Mindoo TodoManager maakt van Coveys vierkwadrantenmethode (belangrijk/niet belangrijk, urgent/niet urgent) een visuele taakworkflow om gefocust te blijven op wat het meest uitmaakt. [Mindoo Weather](https://github.com/klehmann/mindoodb-app-weather) is een tegel in de stijl van iOS Weather die een verwachting voor tien dagen plus de luchtkwaliteit voor een of meer locaties toont, ingesteld via een startparameter — die past zich live aan de tegelgrootte aan die Haven meldt (smal: één veegbare kaart met puntjes; breder: twee tot vier tegelijk) en haalt alle gegevens uit de sleutelloze API's van Open-Meteo, waardoor die ook dient als referentie voor de UX-kant van de SDK. De catalogus draagt ook de App Builder, die uit een beschrijving die je typt een nieuwe app schrijft, publiceert en installeert, en de SDK Example App voor ontwikkelaars die een levende referentie van elke SDK-functie willen. Ze zijn allemaal gratis te gebruiken.

Het onderliggende MindooDB-platform is open source onder de Apache 2.0-licentie. Dat doet meer dan het prijskaartje: er is geen data-lock-in. Het gegevensmodel, de content-geadresseerde opslag en het synchronisatieprotocol zijn allemaal gedocumenteerd en opnieuw te implementeren, wat betekent dat een team zijn versleutelde gegevens altijd mee kan nemen — en het is zelfs mogelijk om volledig alternatieve clients op hetzelfde platform te bouwen als Haven voor een bepaald gebruik niet past. Haven is de officiële client; het is niet de enige mogelijke.

Haven Enterprise is een commerciële editie die Mindoo GmbH verder uitbouwt, gebouwd op precies dezelfde MindooDB-kern. De functies worden vrijgeschakeld met een Enterprise-licentiesleutel en komen één voor één beschikbaar in plaats van allemaal tegelijk. De eerste die je vandaag al kunt gebruiken is de meereizende werkruimte over apparaten en browserprofielen heen: de instelling Meereizende werkruimte onder Instellingen → Algemeen is precies deze functie, en daarom blijft de schakelaar uit tot er een licentie is ingelezen. Nog in aanbouw zijn eigen branding (logo, kleuren, productnaam en domein, zodat Haven als je eigen product voelt), een beheerde gebruikersinterface met organisatiespecifieke standaarden, beheerde werkruimtesjablonen die naar gebruikers worden gestuurd zodat zij in een ingerichte omgeving landen, een interne app store om interne en externe MindooDB-apps te cureren, automatische geplande back-ups van de gegevens in de browser, eersteklas back-upgereedschap voor de tenantgegevens op je server, en inline bewerken van gangbare Office- en tekstbijlagen zonder die te hoeven downloaden. De lijst blijft groeien terwijl de Enterprise-client volwassen wordt — klantfeedback vormt de roadmap direct.

Voor Haven Enterprise kiezen haalt je nooit van het open platform. De MindooDB-kern en de Haven-PWA blijven gratis en open; Enterprise is een aparte, commerciële client die erbovenop ligt. Je kunt op Community beginnen, later naar Enterprise gaan, en in beide richtingen blijven je gegevens en je server precies waar ze waren.

Voor actuele details, prijzen en de lijst voor vroege toegang tot Haven Enterprise, zie de prijzenpagina van Haven op [mindoodb.com/nl/haven/pricing](https://mindoodb.com/nl/haven/pricing/).

## Waar je verder kunt kijken

Haven is een actief product en het is ook het publieke gezicht van MindooDB. Een paar bronnen zijn een bladwijzer waard.

De makkelijkste manier om Haven echt te proberen is [haven.mindoodb.com](https://haven.mindoodb.com) in een moderne browser openen — dat is de live Community-client.

De productpagina's op [mindoodb.com](https://mindoodb.com/nl/) gaan dieper in op de positionering en het beveiligingsmodel, en behandelen de delen van het verhaal die een handboek niet kan brengen — schermafbeeldingen, roadmap en het bredere MindooDB-platform.

De [MindooDB App SDK op GitHub](https://github.com/klehmann/mindoodb-app-sdk) is de TypeScript-bibliotheek om apps te bouwen die binnen Haven draaien. Twee begeleidende opensourceprojecten laten zien hoe apps van productiekwaliteit erop uitzien: het [voorbeeldproject](https://github.com/klehmann/mindoodb-app-example) is een Vue 3-referentie-app die elke SDK-functie over drie tabbladen demonstreert (Databases, Weergaven, Events) — de live demo staat op [app-example.mindoodb.com](https://app-example.mindoodb.com) en kan met een externe URL in Haven worden geregistreerd voor een paar minuten praktische verkenning; en [`mindoodb-app-weather`](https://github.com/klehmann/mindoodb-app-weather) richt zich op de UX-kant van de SDK en toont startparameters, viewport-events en responsief insluiten via een verzorgde tegel in de stijl van iOS Weather.

Vergeet binnen Haven zelf de Help-knop in de bovenbalk niet. Elk scherm heeft zijn eigen hulpartikel, geschreven in dezelfde vriendelijke stijl als dit handboek, en een korte rondleiding die de belangrijke bedieningselementen uitlicht. Twijfel je op een scherm dat je nog niet hebt gebruikt, open die dan eerst — dat is meestal sneller dan er elders over lezen.

Dat is Haven. Een local-first, end-to-end versleutelde, app-hostende werkruimte in een browsertabblad. Privé door ontwerp, rustig als standaard, en klaar of je online bent of niet.
