# Podręcznik Haven

Kompletny, przyjazny przewodnik po MindooDB Haven — przeglądarkowym obszarze roboczym do zaszyfrowanej, local-first współpracy na MindooDB.

Ten podręcznik przechodzi przez wszystko, co robi Haven, w kolejności, w jakiej najprawdopodobniej to napotkasz. Jest napisany dla trzech częściowo pokrywających się grup odbiorców: zwykłych użytkowników, którzy spędzają czas w obszarze roboczym, administratorów zespołu, którzy zakładają tenanty i rejestrują aplikacje, oraz administratorów platformy, którzy prowadzą serwer MindooDB. Nie musisz czytać go od początku do końca. Jeśli znasz już podstawy, nagłówki sekcji pozwolą Ci przejść od razu do tego, czego potrzebujesz. Jeśli jesteś tu zupełnie nowy, zacznij od początku i przejdź przewodnik pierwszych dziesięciu minut.

## Czym jest Haven i dlaczego istnieje

Haven to wizualne wejście do MindooDB. Samo MindooDB jest silnikiem bazy danych: przechowuje zaszyfrowane dokumenty na jakimś serwerze, synchronizuje je między urządzeniami i prowadzi kryptograficznie podpisaną historię każdej zmiany. Haven jest graficznym obszarem roboczym, na który faktycznie patrzysz. Działa w całości w przeglądarce internetowej, zawiera wszystko, czego potrzebujesz do codziennej pracy z MindooDB, i trzyma Twoje dane na Twoim własnym urządzeniu, kiedy tylko może.

Kilka rzeczy odróżnia Haven od typowej aplikacji webowej.

Haven jest local-first. Niemal wszystko, co widzisz, pochodzi z kopii — lokalnej repliki — przechowywanej w tej przeglądarce. Przeglądanie, edycja, wyszukiwanie, a nawet budowanie widoków wirtualnych odbywa się na lokalnej replice, dzięki czemu Haven jest szybki i pozostaje użyteczny, gdy sieci nie ma. Serwer jest odpytywany tylko przy synchronizacji, a dane w transmisji są zawsze szyfrowane end-to-end.

Haven jest progresywną aplikacją webową (PWA). Możesz go zainstalować na telefonach i tabletach, w tym na iPhonie, iPadzie i Androidzie, i uruchamiać wprost z ekranu głównego jak aplikację natywną. Po instalacji otwiera się w trybie samodzielnym, bez elementów przeglądarki, co daje więcej miejsca na ekranie i spokojniejsze wrażenie. Na iPhonie możesz nawet dodać Haven do ekranu głównego więcej niż raz — każda zainstalowana kopia dostaje własny prywatny magazyn, co jest czystym sposobem na całkowite rozdzielenie danych prywatnych, służbowych i demonstracyjnych na jednym urządzeniu.

Haven jest domem uruchomieniowym dla aplikacji MindooDB. Aplikacje MindooDB to małe narzędzia webowe zbudowane na MindooDB App SDK. Haven uruchamia każde z nich w piaskownicy iframe na osobnym originie, przekazuje mu zawężony widok danych, które wybrałeś do udostępnienia, i pośredniczy w każdym odczycie i zapisie przez bezpieczny mostek. Hostowane aplikacje może wydawać nawet własny service worker Haven i działają dalej, gdy sieci nie ma.

Haven ma motyw jasny i ciemny, które domyślnie idą za ustawieniem systemu i można je przełączać ręcznie. Aktywny motyw jest przekazywany na żywo każdej aplikacji MindooDB działającej w Haven, więc osadzone aplikacje automatycznie dopasowują się do wyglądu Haven, bez żadnej dodatkowej pracy.

Pod tym wszystkim leży ta sama obietnica, którą MindooDB składa wszędzie indziej: klucze zostają na urządzeniach, serwery widzą wyłącznie szyfrogram, a nawet pełne włamanie na serwer nie daje niczego czytelnego. Haven jest zaprojektowany tak, by był najwygodniejszym sposobem życia z tą obietnicą.

## Podstawowe pojęcia w pięć minut

Jeśli rozumiesz tę garść słów, reszta podręcznika czyta się naturalnie.

Tożsamość użytkownika to Twoje konto w Haven. Jest lokalnie zaszyfrowanym plikiem, który zawiera Twoje dane publiczne i zaszyfrowane klucze prywatne, odblokowywanym kluczem dostępu na Twoim urządzeniu albo wybranym przez Ciebie hasłem. Tożsamości powstają lokalnie w Twojej przeglądarce i nigdy jej nie opuszczają, o ile sam ich nie wyeksportujesz. Haven może trzymać kilka tożsamości obok siebie i przełączać się między nimi z górnego paska. Utrata każdego sekretu, który odblokowuje tożsamość, jest nieodwracalna — nie ma linku resetującego, bo nikt poza Twoim urządzeniem nie ma klucza.

Tenant to prywatny obszar roboczy Twojego zespołu w MindooDB. Wszyscy, którzy widzą określony zestaw baz danych, są członkami tego samego tenanta. Tenanty zawierają bazę danych katalogu (w której leżą rejestracje użytkowników i ustawienia całego tenanta), jedną lub więcej baz danych aplikacji oraz zestaw kluczy szyfrujących. Tenanty powstają w całości po stronie klienta i mogą zostać opublikowane na serwerze, gdy będziesz gotów do współpracy.

Lokalna replika to zsynchronizowana kopia baz danych tenanta trzymana lokalnie w przeglądarce. To ona sprawia, że Haven wydaje się natychmiastowy. Praca na lokalnej replice jest szybka, działa offline i jest zalecanym sposobem przeglądania i edycji.

Baza danych to zbiór powiązanych dokumentów wewnątrz tenanta — kontakty, faktury, notatki, cokolwiek zespół potrzebuje. Dokument to jedna pozycja w tej bazie danych. Każdy dokument jest CRDT Automerge, czyli technologią, która pozwala dwóm osobom edytować ten sam dokument w tym samym czasie i automatycznie scalić ich zmiany bez okna konfliktu.

Każda zmiana dokumentu jest podpisana kluczem prywatnym autora i dołączona do historii dokumentu. Każda zmiana jest też kryptograficznie powiązana ze zmianą poprzednią, trochę jak w blockchainie, więc łańcuch edycji tworzy sekwencję, w której manipulacja jest widoczna, a nie worek luźnych rewizji. Tę historię pokazuje Haven w Przeglądarce baz danych i w eksploratorze DAG. Ponieważ zmiany są podpisane i połączone w łańcuch, nikt nie przepisze przeszłości po cichu: zmiana albo usunięcie wcześniejszej zmiany zerwałaby każde następujące po niej ogniwo.

KeyBag to lokalny, zaszyfrowany magazyn kluczy szyfrujących, których potrzebuje tenant, otwierany przez tożsamość będącą jego właścicielem. Każdy użytkownik trzyma własny KeyBag w swojej przeglądarce. Klucz domyślny jest udostępniony każdemu członkowi tenanta; klucze nazwane to dodatkowe klucze, które można przekazać mniejszej grupie na potrzeby wrażliwych dokumentów.

Widok wirtualny to drzewo w stylu arkusza kalkulacyjnego, które filtruje, kategoryzuje, sortuje i podsumowuje dokumenty. Widok może czerpać z jednej bazy danych, z kilku baz danych, a nawet z kilku tenantów — i właśnie tak odpowiadasz na pytania przekrojowe, a nie tylko na pytania wewnątrz jednej bazy danych.

Obszar roboczy składa się z kafelków na stronach, zebranych w grupy. Kafelek — nazywany też Chicklet — to przeciągalna karta o zmiennym rozmiarze, która otwiera bazę danych, uruchamia aplikację albo pokazuje notatkę, stronę internetową, wideo lub diagram. Strona to karta pełna kafelków. Grupa skupia powiązane kafelki pod wspólnym, oznaczonym kolorem nagłówkiem.

Rejestracja aplikacji to zapisana po stronie Haven definicja aplikacji MindooDB: gdzie leży, jak się uruchamia i które bazy danych lub widoki wolno jej zobaczyć. Gdy aplikacja się uruchamia, rozmawia z Haven przez mostek (nazywany też app connectorem), czyli bezpieczny kanał, który pozwala Haven wymuszać przyznane przez Ciebie uprawnienia. Piaskownica to izolacja wymuszana przez przeglądarkę, która nie dopuszcza aplikacji do magazynu Haven, jego ciasteczek ani innych aplikacji.

To są wszystkie elementy. Wszystko inne w Haven jest ekranem do pracy z nimi.

## Jak się poruszać po Haven

Haven kładzie wszystko na jednej powierzchni. Wąski górny pasek biegnie u góry, a pod nim leży obszar roboczy — strona, od której zaczynasz, do której wracasz i z której nawigujesz. Nie ma paska bocznego ani osobnego drzewa menu do nauczenia.

Górny pasek jest taki sam na każdym ekranie. Po lewej sygnet MindooDB Haven jest linkiem powrotnym do obszaru roboczego, gdziekolwiek jesteś. Po prawej są dwie rzeczy: plakietka tożsamości pokazująca aktualnie aktywnego użytkownika oraz przycisk Pomoc. Naciśnij plakietkę, aby otworzyć przełącznik tożsamości; kliknij ją prawym przyciskiem albo przytrzymaj, aby dostać szybkie menu przełączające między trybem jasnym i ciemnym albo blokujące sesję. Przycisk Pomoc otwiera kontekstową szufladę pomocy dla ekranu, na którym jesteś. Każdy ekran ma własny artykuł, napisany w tym samym przyjaznym stylu co ten podręcznik, plus krótki przewodnik reflektorowy, który podświetla warte poznania elementy — jeśli kiedykolwiek poczujesz się zagubiony, ten przycisk jest pierwszą rzeczą, którą warto spróbować. Na telefonie lub tablecie Haven będzie Cię czasem zachęcał z górnego paska, żebyś dodał go do ekranu głównego.

Obszar roboczy otwiera się na karcie Start, a Start jest drzwiami wejściowymi Haven. U jego góry biegnie rząd sześciu kafelków skrótów, po jednym dla każdego z własnych ekranów Haven: Kreator konfiguracji nowego środowiska, Haven App Store, Synchronizuj z serwerem, Szybki skan, Widoki wirtualne i Ustawienia. Każdy z nich ma dalej w tym podręczniku własną sekcję. Pod skrótami Start wymienia po jednym kafelku dla każdej zainstalowanej aplikacji, więc pełni jednocześnie rolę katalogu tego, co jest dla Ciebie dostępne. Kliknij dwukrotnie dowolny kafelek, aby go otworzyć, albo użyj przycisku ⋮ w jego narożniku, aby dostać należące do niego akcje.

Start jest celowo nieruchomy. Sześć skrótów jest zawsze w tym samym miejscu i nie można ich przenieść, usunąć ani przestawić, a Start nie jest miejscem na Twoje własne kafelki — to jedna strona, o której możesz założyć, że jutro będzie wyglądać tak samo. Wszystko, co układasz sam, leży na stronach, które zakładasz obok Startu; opisuje je sekcja o obszarze roboczym poniżej.

Szuflada aplikacji to sposób przechodzenia między rzeczami, które masz otwarte. Kiedy tylko działa jakaś aplikacja albo jest otwarty jakiś ekran Haven, u góry obszaru treści pojawia się mały uchwyt ze strzałką; kliknięcie go rozsuwa szufladę w dwóch częściach. Widoki wymienia otwarte ekrany Haven — Synchronizacja, Ustawienia, Widoki wirtualne, kreator konfiguracji — a Aplikacje wymienia aktualnie działające aplikacje MindooDB. Nad jednym i drugim leży wpis Wróć do obszaru roboczego. Z kafelka aplikacji w szufladzie możesz też zsynchronizować lokalne bazy danych tej aplikacji z serwerem, przeładować ją, otworzyć okno informacyjne albo ją zamknąć.

Dwa skróty klawiszowe sprawiają, że warto poznać szufladę porządnie. `Cmd+Shift+Enter` odsyła Cię do obszaru roboczego z dowolnego miejsca, także z wnętrza działającej aplikacji, a `Cmd+Shift+Space` otwiera i zamyka szufladę. W systemach Windows i Linux naciskaj `Ctrl` zamiast `Cmd`. Haven przekazuje oba skróty osadzonym aplikacjom, więc działają dalej nawet wtedy, gdy fokus klawiatury ma aplikacja.

To, co otworzysz, zostaje otwarte. Uruchom aplikację albo otwórz stronę synchronizacji, odejdź gdzieś indziej, a kiedy wrócisz, wciąż siedzi w szufladzie — z zachowaną pozycją przewijania, niezapisanymi zmianami i otwartymi kartami.

Kiedy zainstalujesz Haven na telefonie i uruchomisz go z ekranu głównego, otworzy się w trybie samodzielnym, który usuwa pasek adresu i pasek kart przeglądarki. Niektóre ekrany wewnątrz Haven — głównie te immersyjne, jak działająca aplikacja na pełnym ekranie — z tego samego powodu ukrywają też górny pasek.

## Twoje pierwsze 10 minut

Kiedy otwierasz Haven po raz pierwszy, nie ma tam czego szukać ani co konfigurować: Haven prowadzi Cię od razu do kreatora konfiguracji, który zamienia cały początek — tożsamość, administratora, tenanta albo dołączenie do istniejącego zespołu — w krótki, prowadzony przebieg. Haven rozstrzyga to, patrząc na urządzenie. Gdy znajdzie i nazwaną tożsamość użytkownika, i tenanta, otwarcie Haven ląduje w obszarze roboczym; dopóki ich nie znajdzie, ląduje w kreatorze. Możesz do niego wrócić, kiedy tylko chcesz, kafelkiem Kreator konfiguracji nowego środowiska na Starcie — i tak samo dodaje się później drugiego tenanta. Wszystko, co robi kreator, da się zrobić ręcznie przez Ustawienia → Identyfikatory użytkowników i Ustawienia → Tenanty, ale kreator jest zdecydowanie najłatwiejszą drogą, więc korzystaj z niego, kiedy tylko możesz.

Kreator otwiera się krótkim wprowadzeniem (szyfrowanie end-to-end, local-first, serwery zero-trust) i trzema dużymi przyciskami: Utwórz tenanta, Dołącz do zespołu i Otwórz tenanty. Pod nimi dwie karty wyjaśniają, co każda z tych dróg właściwie robi. Jeśli Haven ma już odblokowaną tożsamość, mówi Ci o tym mały baner — kreator chętnie ją wykorzysta i pominie krok tożsamości, jeśli tego chcesz.

### Droga pierwsza: zakładasz własnego tenanta

Jeśli zaczynasz od zera, naciśnij Utwórz tenanta. Kreator przeprowadzi Cię przez cztery kroki na jednej stronie.

Krok pierwszy, utwórz swoją tożsamość użytkownika. To jest Twoje konto w Haven — mały, lokalnie zaszyfrowany plik, który zawiera Twoje dane publiczne i zaszyfrowane klucze prywatne. Możesz albo użyć ponownie tożsamości już odblokowanej w górnym pasku, albo utworzyć zupełnie nową, wpisując nazwę użytkownika (na przykład `cn=user/o=acme`).

Potem wybierz, jak chcesz odblokowywać tę tożsamość na co dzień. Haven z góry zaznacza Klucz dostępu, gdy przeglądarka go obsługuje, bo jest to opcja zarazem łatwiejsza i mocniejsza: Twoje urządzenie pyta o Face ID, Touch ID, Windows Hello albo klucz bezpieczeństwa i lokalnie wyprowadza klucz, który otwiera Twoje klucze prywatne. Hasło jest alternatywą i jest właściwym wyborem na urządzeniu współdzielonym, gdzie ktoś inny zna kod odblokowania, albo gdy chcesz, żeby ta sama tożsamość działała w konsoli. Tak czy inaczej sekret zostaje na tym urządzeniu — nie ma procedury odzyskiwania ani serwera, który mógłby odblokować Twoją tożsamość za Ciebie, więc zapisz wybrany sekret, zanim przejdziesz dalej. Drugą metodę możesz dodać później w Ustawienia → Identyfikatory użytkowników.

Krok drugi, skonfiguruj osobną tożsamość administratora. MindooDB celowo trzyma administratora tenanta i codziennego użytkownika aplikacji osobno, żeby jeden skompromitowany sekret nie mógł przejąć zarazem zarządzania katalogiem i codziennej pracy na dokumentach. Tutaj wybierasz, jak ma być chroniona tożsamość administratora: albo Haven wygeneruje sześciowyrazową frazę hasłową, albo wpiszesz własne hasło z typowym polem powtórzenia. Wygenerowana fraza jest pokazywana raz, z przyciskami do skopiowania jej albo pobrania jako pliku tekstowego, oraz z polem wyboru potwierdzającym, że ją zapisałeś, żebyś nie mógł jej przez przypadek pominąć. Tak czy inaczej celowo nie jest to klucz dostępu: administrator, którego odblokujesz tylko przez Face ID tego urządzenia, to administrator, którego tracisz razem z urządzeniem — a praca administracyjna jest dokładnie tym, czego potrzebujesz po wymianie laptopa. Trzymaj ją tam, gdzie trzymasz inne awaryjne dane dostępowe.

Krok trzeci, utwórz samego tenanta. Haven generuje identyfikator tenanta za Ciebie i nie da się go potem zmienić. To jest celowe: gdy kilka zespołów dzieli jeden serwer MindooDB, identyfikatory tenantów muszą być unikatowe, a identyfikator wpisany ręcznie to identyfikator, który kiedyś zderzy się z czyimś innym. Wybierasz natomiast etykietę tenanta — krótką, łatwą do zapamiętania nazwę, żebyś rozpoznał tego tenanta później — i każdy administrator może ją w każdej chwili zmienić, bo etykieta jest tam tylko dla ludzi. Haven generuje następnie klucze szyfrujące tenanta, klucz domyślny dla Twoich treści i drugi dla katalogu dostępu, zapisuje je w Twoim lokalnym KeyBagu i podłącza obie tożsamości. Na tym etapie wszystko zostaje lokalnie w Twojej przeglądarce; nic nie zostało jeszcze wypchnięte na serwer.

Krok czwarty, wszystko gotowe. Haven wrzuca Cię do Twojego pustego obszaru roboczego, już odblokowanego, już wewnątrz nowego tenanta. Gdy będziesz gotów do współpracy, opublikuj tenanta na serwerze MindooDB: strona synchronizacji ma dla każdego tenanta wciąż istniejącego tylko lokalnie przycisk Przenieś na serwer, a to samo znajdziesz w Ustawienia → Tenanty.

### Droga druga: dołączasz do istniejącego zespołu

Jeśli ktoś z zespołu założył już tenanta na serwerze MindooDB, naciśnij zamiast tego Dołącz do zespołu. Kreator ma ten sam czterokrokowy układ, ale idzie trzykrokowym przebiegiem dołączania MindooDB, w którym Twoje klucze prywatne nigdy nie opuszczają tego urządzenia.

Krok pierwszy, utwórz swoją tożsamość użytkownika (albo użyj ponownie aktywnej), dokładnie jak na drugiej drodze.

Krok drugi, wyślij żądanie dołączenia. Haven buduje z Twoich kluczy publicznych adres URL żądania dołączenia — bez żadnych sekretów — i pokazuje Ci go z przyciskiem do skopiowania adresu. Wyślij ten adres administratorowi tenanta dowolnym kanałem (e-mailem, czatem, systemem zgłoszeń); można go bezpiecznie udostępnić otwarcie, bo zawiera wyłącznie Twoje klucze publiczne. Administrator otworzy swój Haven, użyje na Twoim żądaniu akcji Przyznaj dostęp do tenanta i odeśle dwie rzeczy: adres URL odpowiedzi dołączenia oraz krótkie wspólne hasło. Ważne: wspólne hasło musi przyjść osobnym, bezpiecznym kanałem — telefonicznie, innym komunikatorem albo osobiście — bo odpowiedź niesie klucze szyfrujące obszaru roboczego.

Krok trzeci, dokończ dołączanie. Wklej do kreatora adres URL odpowiedzi dołączenia, wpisz adres serwera, na którym leży tenant (dla znanych serwerów są skróty na jedno kliknięcie), i wpisz wspólne hasło, które administrator przekazał Ci osobno. Haven weryfikuje serwer, pobiera początkowe dane katalogu i dodaje tenanta do Twojego Haven.

Krok czwarty, jesteś w środku. Haven wrzuca Cię do świeżo dołączonego tenanta, a obszar roboczy jest gotowy do zapełnienia kafelkami.

### Po kreatorze

Gdy kreator powitalny się skończy, codzienna droga jest taka sama, którąkolwiek trasą poszedłeś.

Otwórz obszar roboczy. Start ma już swoje sześć kafelków skrótów; czego jeszcze nie ma, to czegokolwiek Twojego. Dodaj stronę obok Startu z menu dodawania, a potem tym samym menu połóż na niej kafelek bazy danych wskazujący na jedną z baz danych w Twoim tenancie. Kliknij kafelek dwukrotnie, aby otworzyć Przeglądarkę baz danych i zobaczyć jego dokumenty.

Zainstaluj aplikację. Otwórz ze Startu Haven App Store, wybierz coś, co wygląda przydatnie, i zainstaluj. Pojawi się od razu jako kafelek na Starcie, a stamtąd możesz ją położyć na jednej ze swoich stron.

Uruchom synchronizację. Otwórz ze Startu Synchronizuj z serwerem i naciśnij Synchronizuj wszystko, albo użyj akcji Synchronizuj w konkretnym wierszu, jeśli chcesz odświeżyć tylko jedną bazę danych. Gdy w kolumnie statusu pojawi się zielony znacznik, Twoja lokalna replika jest zgodna z serwerem.

Wróć do obszaru roboczego i dodawaj dalsze kafelki — aplikacje, notatki, strony internetowe, pulpity, wszystko, co sprawia, że Twój obszar roboczy czuje się jak dom.

Jeśli któryś krok wydaje się abstrakcyjny, otwórz na tym ekranie przycisk Pomoc. Pomoc w aplikacji ma przewodnik reflektorowy, który podświetla dokładnie to, co trzeba kliknąć. A kreator konfiguracji możesz zawsze otworzyć ponownie z jego kafelka na Starcie — chętnie wykorzysta istniejącą tożsamość albo pomoże Ci utworzyć kolejne.

### Haven jest wielotenantowy z założenia

Nic nie zatrzymuje się na jednym tenancie. Kreator powitalny można uruchomić ponownie w dowolnym momencie, a każdy nowy tenant jest kryptograficznie niezależny od każdego innego — ma własne klucze szyfrujące, własny wpis w KeyBagu, własny łańcuch administracyjny, własną podpisaną historię. Ta niezależność sprawia, że bezpiecznie jest trzymać pod jednym dachem bardzo różne konteksty.

Częstym układem jest prowadzenie równolegle trzech albo czterech tenantów: jednego do pracy, jednego do spraw prywatnych, jak planowanie domowe albo projekt poboczny, i jeszcze jednego dzielonego z firmą partnerską na potrzeby współpracy międzyorganizacyjnej. Możesz używać tej samej tożsamości użytkownika we wszystkich albo utworzyć dedykowaną tożsamość na tenanta — wybór jest Twój, bo nic nie łączy tenantów ze sobą poza tym, że akurat leżą w tej samej przeglądarce.

Haven jest prawdziwie wielotenantowy, a nie jednotenantowy z przełączaniem. Możesz mieć kilka tenantów odblokowanych i aktywnych w tym samym czasie, mieszać ich dane na jednej stronie obszaru roboczego i mapować bazy danych z różnych tenantów za osobnymi logicznymi uchwytami do tej samej aplikacji, żeby mogła pracować ponad granicami organizacji, nigdy nie widząc więcej, niż powinna. Widoki wirtualne idą o krok dalej: jeden widok może czerpać z kilku baz danych w kilku tenantach i kategoryzować, sortować oraz podsumowywać ich dokumenty, jakby były jednym zbiorem danych. Na przykład widok do planowania osobistego może połączyć Twoją prywatną listę zadań z zadaniami służbowymi przypisanymi Ci w tenancie firmowym, mimo że oba zbiory danych są zaszyfrowane całkowicie różnymi kluczami i synchronizowane z całkowicie różnymi serwerami.

Dodawaj tenanty, kiedy tylko pojawia się nowy kontekst. Trzymanie ich obok siebie jest tanie, a kryptograficzne rozdzielenie oznacza, że nigdy nie musisz się martwić wyciekiem danych z jednego do drugiego.

## Używanie Haven na więcej niż jednym urządzeniu

Haven trzyma Twoje dane w przeglądarce, w której działa. To jest to, co czyni go szybkim i co trzyma Twoje klucze poza cudzymi serwerami, ale oznacza też, że druga przeglądarka — Safari na Twoim iPhonie, służbowy laptop, kolejna zainstalowana kopia Haven na tym samym telefonie — startuje jako obcy. Ma własny magazyn, własne klucze urządzenia i żadnej możliwości przeczytania czegokolwiek, dopóki urządzenie, któremu już ufasz, jej nie wpuści. Ta sekcja jest o tym momencie.

W grę wchodzą dwa różne uprawnienia, a trzymanie ich osobno jest tym, co czyni ten model bezpiecznym. Pierwsze to zgoda na synchronizację: administrator tenanta nadaje Twojej nazwie użytkownika dostęp i od tej pory serwer jest gotów wydawać Twoim urządzeniom zaszyfrowane dane. Drugie to zgoda na odczyt: klucze, które zamieniają ten szyfrogram z powrotem w dokumenty. Serwer może nadać pierwsze, bo tylko przenosi bajty, ale nigdy nie może nadać drugiego, bo nigdy nie miał żadnego klucza. Zupełnie nowe urządzenie może więc dokończyć synchronizację, trzymać lokalnie każdy bajt bazy danych i nadal nie mieć w niej niczego, co potrafi przeczytać. Haven nigdy nie wymienia dokumentu, którego nie potrafi odszyfrować, więc objawem nie jest wiersz, który odmawia otwarcia: to baza danych wyglądająca na pustą albo widok znacznie krótszy, niż się spodziewałeś, na urządzeniu, które właśnie zgłosiło udaną synchronizację. To nie jest błąd ani na wpół dokończone dołączanie; to jest projekt, a baner opisany poniżej jest tym, co pozwala rozróżnić jedno od drugiego. Przeglądarka baz danych podaje też liczbę: jej nagłówek liczy dokumenty, które możesz przeczytać, i gdy to urządzenie trzyma dokumenty, których Twoje klucze nie otwierają, mówi, ile jest ukrytych — „Dokumenty (3) · ukryte: 7” to urządzenie, które ma dziesięć, a umie przeczytać trzy. Liczba dotyczy tego, co tu dotarło, nie tego, co trzyma tenant, więc rośnie, gdy synchronizacja przyniesie więcej.

Lukę wypełnia Twój klucz użytkownika. Każda osoba w tenancie ma dokładnie jeden — parę kluczy szyfrujących, która należy do Ciebie, a nie do urządzenia czy do samego tenanta. Jej połowa publiczna jest opublikowana w tenancie, żeby koledzy z zespołu i administratorzy mogli szyfrować dla Ciebie — i tak trafia do Ciebie w pierwszej kolejności klucz domyślny tenanta. Jej połowa prywatna istnieje wyłącznie na urządzeniach, które zatwierdziłeś. Zatwierdzenie urządzenia oznacza zapisanie kolejnej kopii tej prywatnej połowy w katalogu użytkowników tenanta, zapakowanej tak, że otworzy ją tylko własny klucz nowego urządzenia. Serwer przechowuje i przekazuje tę kopię jak wszystko inne, nigdy nie mogąc jej przeczytać.

Na nowym urządzeniu zobaczysz u dołu ekranu baner: „To urządzenie czeka na zatwierdzenie”. Nazywa, który dostęp się zaciął — na przykład „Tenant acme · na Server1/ACME”, gdzie druga połowa to własna kanoniczna nazwa serwera, ta sama, którą pokazuje karta Tenanty, z zapasowym adresem, jeśli serwer nigdy żadnej nie zgłosił — bo ten sam tenant może być synchronizowany przez więcej niż jeden serwer jednocześnie, a samo „czekam” nic w takiej sytuacji nie mówi. Pod tym baner nazywa brakujące Ci klucze, żebyś wiedział, co wróci, gdy czekanie się skończy: dokumenty, które potrzebują klucza domyślnego, zostają do tego czasu ukryte. Jeśli dołączyłeś z tego urządzenia do kilku tenantów, jeden wiersz mówi, ile kolejnych czeka w kolejce za tym. Baner celowo siedzi na każdej stronie, a nie tylko w obszarze roboczym, bo urządzenie bez kluczy jest zablokowane wszędzie, a droga wyjścia musi zostać w zasięgu. „Sprawdź ponownie” odczytuje katalog na miejscu; „Otwórz przywracanie” prowadzi do ostatniej deski ratunku opisanej na końcu tej sekcji.

Na urządzeniu, które jest już zatwierdzone, druga połowa tego przebiegu przychodzi jako okno dialogowe krótko po odblokowaniu: „Zatwierdź nowe urządzenie”. Pokazuje etykietę urządzenia, ten sam wiersz z tenantem i serwerem, żebyś widział, co zamierzasz wydać, oraz kiedy urządzenie zostało dodane. „Zatwierdź to urządzenie” zapisuje zapakowaną kopię Twojego klucza użytkownika i wypycha ją dalej. „Nie teraz” odkłada pytanie do następnego uruchomienia Haven, co jest właściwą odpowiedzią, gdy jesteś w środku zadania, a urządzenie jest naprawdę Twoje. „Nie pytaj ponownie” jest odpowiedzią stanowczą: urządzenie zostaje zapisane jako odrzucone, każde zatwierdzone urządzenie przestaje o nie pytać, a na Twojej liście urządzeń pojawia się jako „Ukryte”. Odrzucenie nie wyrzuca urządzenia z tenanta — nadal może się synchronizować — po prostu nigdy nie dostaje kluczy, więc wszystko, co zsynchronizuje, zostaje dla niego niewidoczne. Gdy czeka kilka urządzeń, Haven pyta o nie po kolei.

Zatwierdzenie podróżuje przez katalog użytkowników tenanta, co czyni je synchronizacją, a nie żywym uzgodnieniem. Oba urządzenia nigdy nie rozmawiają ze sobą bezpośrednio i urządzenie zatwierdzające nie musi zostać otwarte: zatwierdzenie jest zapisane, wypchnięte na serwer i podniesione przez czekające urządzenie przy następnym pobraniu — przy następnej synchronizacji katalogu, gdy naciśniesz „Sprawdź ponownie”, albo gdy Haven następnym razem wystartuje. Jeśli żadne z urządzeń nie dosięga serwera, nic się nie rusza, dopóki któreś nie dosięgnie.

Ustawienia → Identyfikatory użytkowników mają pełny obraz w sekcji „Twoje urządzenia” i to tam idziesz, gdy okno dialogowe zostało zamknięte albo trzeba cofnąć odrzucenie. Każdy wiersz to jedno urządzenie z etykietą, datą dodania, tenantem, do którego należy, i statusem: „Zatwierdzone”, „Oczekuje na zatwierdzenie” albo „Ukryte”. Czekające urządzenia dostają przycisk „Zatwierdź”, ukryte przycisk „Mimo to zezwól”, który przywraca urządzenie do stanu oczekiwania, żeby dało się je normalnie zatwierdzić. Jedna zasada zaskakuje ludzi za pierwszym razem: zatwierdzenie musi przyjść z urządzenia, które samo jest już zatwierdzone. Urządzenie wciąż czekające na własne zatwierdzenie widzi to zdanie zamiast przycisku i nie może samo się wpuścić — gdyby mogło, cały mechanizm byłby dekoracją. Oznacza to też, że drugie urządzenie w opublikowanym tenancie musi zostać zatwierdzone z pierwszego, więc zatwierdź je, póki masz jeszcze oba.

Jeśli tenant nigdy nie został opublikowany, nic z tego się nie pojawia. Nie ma na serwerze katalogu użytkowników, w który można zajrzeć, ani innego urządzenia, które można zapytać, więc pierwsze urządzenie samo pieczętuje swój klucz użytkownika i po prostu działa. Ten przebieg zaczyna mieć znaczenie w chwili, gdy tenant leży na serwerze i pojawia się drugie urządzenie.

Jest jeszcze jeden przypadek, w którym Haven nie pyta o nic. Jeśli sam przyznasz dostęp na żądanie dołączenia swojego nowego urządzenia, z urządzenia, które już trzyma Twój klucz użytkownika, kopia zostaje zapisana w ramach przyznawania dostępu i nowicjusz przybywa od razu zdolny do czytania. Milczenie jest tu dobrym wynikiem, a nie brakującym krokiem. Dopiero gdy dołączenie zatwierdzi ktoś inny — zwykle administrator tenanta, który Cię rejestruje — nowe urządzenie ląduje w stanie oczekiwania i potrzebuje jednego z Twoich własnych urządzeń, żeby dokończyć sprawę.

Czasem Haven nie umie rozstrzygnąć. Bursztynowy baner mówiący „Haven nie mógł jeszcze ustalić, czy to urządzenie jest zatwierdzone” oznacza, że katalogu użytkowników nie udało się wcale odczytać — zwykle bo serwer jest nieosiągalny — a nie że ktoś Cię odrzucił. Sprawdź sieć i naciśnij „Sprawdź ponownie”. Tam, gdzie ponowne sprawdzenie nie mogłoby nigdy zmienić odpowiedzi, Haven milczy, zamiast trzymać baner w nieskończoność.

Jedyna sytuacja, której ten przebieg nie naprawi, to utrata wszystkich zatwierdzonych urządzeń naraz, bo wtedy nie zostaje nikt, kto mógłby zatwierdzić zamiennik. Do tego służy wydruk awaryjny tenanta na karcie Kopia zapasowa i dlatego baner oczekiwania prowadzi wprost do karty Przywracanie. Wydrukuj jeden na tenanta, póki jest spokojnie; sekcja o kopii zapasowej i przywracaniu wyjaśnia, co taki wydruk zawiera.

## Obszar roboczy

Obszar roboczy jest Twoim codziennym domem. Układasz w nim bazy danych, aplikacje, notatki, strony internetowe, filmy i diagramy jako przeciągalne kafelki na wielu stronach, jak ekrany główne w telefonie. Układ jest osobisty: domyślnie jest przechowywany tylko w tej przeglądarce, więc ładuje się natychmiast i działa offline. Jeśli chcesz mieć ten sam układ na innych urządzeniach, ustawienie Przenoszony obszar roboczy w Ustawienia → Ogólne zapisuje go w Twoim tenancie, zaszyfrowany tylko dla Ciebie.

Strony to karty u góry obszaru roboczego. Pierwszą jest zawsze Start, opisany w sekcji o poruszaniu się po Haven: sześć własnych skrótów Haven plus kafelek dla każdej zainstalowanej aplikacji. Start jest tylko do odczytu, więc nie możesz rzucić na niego własnych kafelków ani przestawić tego, co na nim jest, i jest jedyną stroną, która zawsze wygląda tak samo.

Wszystko inne jest Twoje. Dodaj obok Startu dowolnie wiele stron — jedną na projekt, jedną na rolę, jedną na codzienne pulpity, jedną na prywatne linki — każdą z własną siatką kafelków. Kliknij kartę strony prawym przyciskiem, aby zmienić jej nazwę, kolejność albo ją usunąć.

Kafelki to karty na siatce. Przeciągnij kafelek za nagłówek, aby go przesunąć, przeciągnij narożnik, aby zmienić rozmiar, albo kliknij prawym przyciskiem, aby dostać pełne menu kontekstowe. Upuść kafelek na kartę innej strony, aby go tam przenieść. Upuść kafelek na inny kafelek, aby zacząć grupę.

Grupy skupiają powiązane kafelki pod wspólnym, oznaczonym kolorem nagłówkiem. Grupa jest świetnym sposobem na wizualne trzymanie razem kafelków jednego projektu — na przykład bazy danych, działającej aplikacji i notatki referencyjnej tego samego zespołu. Kliknij nagłówek grupy prawym przyciskiem, aby zmienić jej nazwę, zmienić kolor albo rozgrupować kafelki z powrotem w zwykłe karty.

Na tej samej siatce mieszka kilka rodzajów kafelków.

Kafelek bazy danych wskazuje na jedną bazę danych MindooDB. Kliknij go dwukrotnie, aby otworzyć Przeglądarkę baz danych. Menu kontekstowe pozwala przełączyć, którą kopię bazy danych kafelek pokazuje — lokalną replikę dla szybkości i pracy offline albo żywy cel serwerowy dla najświeższego stanu. Kafelki baz danych pamiętają tenanta, bazę danych i źródło, którego użyłeś ostatnio, więc są też wygodną zakładką z powrotem do resztek MindooDB.

Kafelek aplikacji uruchamia aplikację MindooDB, a o jej zachowaniu decydują dwa osobne ustawienia. Tryb wyświetlania samego kafelka to albo Uruchamianie — karta, którą klikasz dwukrotnie — albo Osadzona, czyli uruchomienie aplikacji wprost w karcie obszaru roboczego, co idealnie pasuje do małych narzędzi do rzucenia okiem, jak formularz do szybkiego zapisu albo mini pulpit. Tryb uruchamiania z rejestracji decyduje z kolei, co właściwie robi uruchomienie: Osadź w Haven otwiera aplikację na całą szerokość wewnątrz okna Haven, gdzie przełączaniem zajmuje się szuflada aplikacji, a Otwórz w nowym oknie daje jej samodzielną kartę przeglądarki — przydatne przy drugim monitorze albo do czytania Haven i aplikacji obok siebie. Aplikacje otwarte wewnątrz Haven działają dalej w tle, gdy nawigujesz gdzieś indziej, więc po powrocie ich pozycja przewijania, niezapisane zmiany i otwarte karty nadal tam są.

Kafelki tekstowe trzymają sformatowane notatki. Kafelki treści internetowej osadzają dowolny adres URL jako mini przeglądarkę — i tak trzymasz system partnera albo pulpit innego zespołu obok danych MindooDB, które ten pulpit dokumentuje. Kafelki wideo odtwarzają treści z YouTube na potrzeby samouczków i przewodników. Kafelki Mermaid renderują na żywo diagramy architektury i schematy przebiegów wprost na siatce. Te kafelki z treścią są osobiste — leżą wyłącznie w tej przeglądarce — więc idealnie pasują do ściągawek, codziennych linków i materiałów referencyjnych na żywo.

Pasek wyszukiwania u góry obszaru roboczego filtruje kafelki na wszystkich stronach po nazwie, bazie danych, tenancie, tagu albo serwerze. Na Starcie możesz dodatkowo sortować to, co tam wymienione, według ostatniego użycia, według tenanta albo alfabetycznie, co staje się najszybszą drogą do znalezienia czegoś, gdy zainstalujesz więcej niż kilka aplikacji.

## Aplikacje i Haven App Store

Aplikacje MindooDB to małe narzędzia webowe, które działają w Haven z zawężonym widokiem Twoich danych. Zdobycie takiej aplikacji to jedno kliknięcie w Haven App Store; wszystko dalej — uruchamianie, konfiguracja, aktualizowanie, usuwanie — odbywa się z jej własnego kafelka na Starcie.

Haven App Store jest katalogiem gotowych aplikacji MindooDB i otwiera się jako okno dialogowe na obszarze roboczym, a nie zabiera Cię gdzieś indziej. Przejrzyj katalog, otwórz wpis, aby przeczytać opis, zrzuty ekranu i wersję, a potem naciśnij Zainstaluj. Haven pyta, w którym tenancie aplikacja ma pracować i jak ma się nazywać, a Zainstaluj teraz kończy sprawę. Nie ma żadnego formularza rejestracji do wypełnienia: Haven pisze go za Ciebie z wpisu katalogu, nadaje aplikacji bazy danych, które ta deklaruje, i aplikacja pojawia się jako kafelek na Starcie, gotowa do uruchomienia. Jeśli na hostowaną aplikację czeka nowsza wersja, kafelek App Store nosi małą plakietkę z liczbą dostępnych aktualizacji.

Rejestracja jest zapisanym kontraktem między Haven a aplikacją: Haven obiecuje uruchamiać ją tak, jak opisuje rejestracja, i wystawiać tylko te dane, na które pozwalają jej mapowania, a aplikacja zgadza się przechodzić przez konektor SDK Haven przy każdym odczycie i zapisie. Instalacja z App Store tworzy rejestrację automatycznie, dlatego większość ludzi nigdy nie musi o tym pojęciu myśleć. Zaczyna mieć znaczenie w dniu, w którym chcesz zmienić to, co wolno aplikacji zobaczyć.

Wszystko, co możesz zrobić z zainstalowaną aplikacją, wisi na menu ⋮ jej kafelka na Starcie. Uruchom aplikację startuje ją z aktywnym użytkownikiem albo wprowadza Cię do istniejącej sesji, jeśli aplikacja już działa, zamiast uruchamiać drugą. Konfiguruj aplikację otwiera rejestrację do edycji — to tam leżą opisane poniżej hosting, tryb uruchamiania i mapowania danych; zmiany wchodzą w życie przy następnym starcie aplikacji i nie potrzeba żadnych zmian w jej kodzie. O tej aplikacji pokazuje jej metadane, takie jak identyfikator aplikacji i bieżąca wersja. Sprawdź aktualizacje pojawia się przy aplikacjach wydawanych z hostowanego pakietu i pobiera nowszą wersję, jeśli wydawca coś wypuścił. Usuń aplikację odinstalowuje ją. Kafelek App Store ma jeden dodatkowy własny wpis, Importuj aplikację, do wciągnięcia gotowej rejestracji, która nie przyszła z katalogu.

Dwie rzeczy określają, jak Haven wydaje aplikację. Pierwsza: gdzie leży kod. Zewnętrzny adres URL wskazuje na serwer developerski albo na wdrożoną aplikację webową działającą gdzieś indziej; będziesz go używać przy pracy nad aplikacją albo gdy hostuje ją inny zespół. Hostowany pakiet to spakowany zestaw zasobów webowych zaimportowany do samego Haven. Gdy pakiet leży już lokalnie, Haven może go wydawać przez własny service worker, co oznacza, że aplikacja startuje z lokalnego magazynu nawet bez sieci — to jest droga do aplikacji naprawdę zdolnych do pracy offline. Tryb hostowany stosuje też listę dozwolonych połączeń sieciowych, którą kontrolujesz; pusta oznacza brak sieci zewnętrznej. Piaskownicę, wtyczkę Vite i to, dlaczego lokalny `vite dev` zostaje przy zewnętrznym adresie wejściowym, opisuje [hosted-app isolation](hosted-app-isolation.md). Druga: jak aplikacja działa. Osadź w Haven uruchamia ją w iframe wewnątrz okna Haven, gdzie przełączaniem zajmuje się szuflada aplikacji. Otwórz w nowym oknie startuje ją zamiast tego jako samodzielną kartę przeglądarki, co jest przydatne przy drugim monitorze.

Częścią rejestracji, która faktycznie Cię chroni, jest mapowanie danych. Dla każdej bazy danych, którą aplikacja ma zobaczyć, wybierasz logiczną nazwę, pod którą aplikacja będzie się do niej odwoływać, oraz przyznawane uprawnienia: tylko odczyt albo odczyt i zapis, czy wolno usuwać, załączniki, historię rewizji i tworzenie widoków wirtualnych definiowanych przez aplikację. Możesz też mapować bazy danych z różnych tenantów albo różnych serwerów za osobnymi logicznymi uchwytami, co pozwala jednej aplikacji pracować ponad granicami, nigdy nie widząc więcej, niż powinna.

Gdy aplikacja się uruchamia, nie rozmawia z magazynem MindooDB bezpośrednio. Woła konektor SDK, który otwiera sesję z Haven, i każdy odczyt, zapis, zapytanie, operacja na załącznikach czy wywołanie historii płynie przez ten konektor. Haven sprawdza każde żądanie wobec skonfigurowanego przez Ciebie mapowania i uprawnień, więc nawet gdyby aplikacja próbowała coś przeskrobać, mostek by odmówił.

Rejestracje podróżują jako pakiety JSON. Eksport aplikacji, wewnątrz okna Konfiguruj aplikację, zapisuje taki pakiet; Importuj aplikację na kafelku App Store czyta go z powrotem. Pakiet może nieść razem z definicją także pliki hostowanego pakietu, więc aplikację rozwijaną w jednej przeglądarce można przekazać komuś z zespołu albo przenieść do innego środowiska bez ręcznego odtwarzania rejestracji.

Nie każda aplikacja przychodzi z katalogu, a resztę przypadków obsługuje menu Nowa aplikacja w App Store. Z adresu URL rejestruje aplikację leżącą pod adresem, który wklejasz — fork, wdrożenie podglądowe albo builder działający na Twojej własnej maszynie; Haven czyta z tego adresu plik `haven-app.json` aplikacji i pokazuje Ci, o co ona prosi, przed zapisaniem czegokolwiek. Nowa pusta aplikacja otwiera pustą rejestrację, gdy chcesz ręcznie wypełnić hosting i mapowania. Na zamówienie, tworzona przez AI prowadzi do App Buildera, o którym jest następna sekcja.

Dobra zasada, gdy poszerzasz dostęp aplikacji: zacznij od tylko odczytu na jednej bazie danych, doprowadź aplikację do działania i dopiero wtedy przyznaj więcej. Znacznie łatwiej jest dodać dostęp do zapisu później niż odebrać go w pośpiechu.

## Budowanie aplikacji w App Builderze

Jedna aplikacja w store istnieje, by produkować inne aplikacje. App Builder bierze opis narzędzia, którego brakuje Twojemu zespołowi — tablicy zadań, listy rezerwacji, grafiku zmian — i zamienia go w działającą aplikację Haven: agent AI pisze kod, aplikacja zostaje opublikowana w sieci pod własnym adresem, a Haven proponuje jej instalację. Nic po Twojej stronie nie wymaga programowania, a wychodzi z tego prawdziwa aplikacja, nie demo.

Instalujesz go z Haven App Store jak wszystko inne. Pierwsze uruchomienie prosi Cię o połączenie trzech kont i to jest jedyna techniczna część całej sprawy. GitHub trzyma kod źródłowy aplikacji, Cloudflare ją publikuje, a Cursor dostarcza AI, które ją pisze. GitHub i Cloudflare łączą się przez własne ekrany zgody jednym kliknięciem każdy, bez żadnego identyfikatora konta ani nazwy właściciela do wyszukiwania. Cursor nie ma przebiegu zgody, więc wklejasz klucz API z jego panelu — a agenci chmurowi, których builder uruchamia, nie są objęci darmowym planem Cursora. To jest też ten element, który możesz odłożyć: bez klucza Cursora projekt i tak zostanie utworzony i opublikowany, po prostu przyjdzie pusty.

Od tej pory zbudowanie aplikacji to nazwa, jedno zdanie o jej przeznaczeniu i krótki opis tego, co ma robić, napisany zwykłym językiem, a nie technicznym żargonem. Naciśnięcie przycisku wprawia w ruch cztery rzeczy. Projekt powstaje z oficjalnego szablonu startowego, który nosi już dokumentację App SDK i przewodnik dobrych praktyk, więc agent pracuje na interfejsach, które faktycznie istnieją, zamiast zgadywać. Aplikacja dostaje własny adres internetowy, podłączony do potoku budowania Cloudflare, więc każdy późniejszy push wdraża ją ponownie sam z siebie. Agent chmurowy podnosi opis i zaczyna pisać, generując po drodze pasującą ikonę aplikacji. A kiedy skończy, builder przekazuje aplikację Haven.

Możesz to wszystko obserwować. Każdy krok zgłasza, co zrobił, a praca agenta jest widoczna w trakcie, więc towarzyszysz jej i dajesz informację zwrotną, zamiast czekać na czarną skrzynkę. Ten kanał zostaje otwarty i później: prośba o kolejną funkcję jest następnym opisem dla tego samego projektu, a agent podejmuje pracę tam, gdzie ją zostawił.

Haven instaluje wynik tak, jak instaluje wszystko inne. Czyta własny opis gotowej aplikacji i najpierw pyta Ciebie, wymieniając bazy danych, uprawnienia i dostęp sieciowy, których nowa aplikacja chce. Gdy zaakceptujesz, jest kafelkiem w Twoim obszarze roboczym jak każdy inny, gotowym do pracy na pełnym ekranie albo osadzonym w karcie.

Warto wprost powiedzieć, co masz na końcu. Kod jest zwykłym repozytorium Git na Twoim własnym koncie GitHub, zbudowanym na tym samym App SDK, którego używają aplikacje własne, z otwartą dla niego całą platformą: bazami danych, widokami wirtualnymi, pracą offline, synchronizacją w czasie rzeczywistym, motywem Haven. AI jest wymienne — skieruj na to repozytorium Claude Code, Codex albo własne ręce, a Cloudflare opublikuje ponownie to, co przyjdzie, kto by tego nie napisał. A ponieważ aplikacja leży pod publicznym adresem, kolega, któremu wyślesz link, może dodać tę samą aplikację do swojego własnego Haven.

Dane dostępowe są traktowane starannie, bo są trzy i są potężne. Leżą w jednym dokumencie w Twojej własnej bazie danych App Buildera, zaszyfrowane osobiście dla Ciebie, więc współdzielona baza danych ich nie odsłania, a następna aplikacja już o nie nie pyta. Token GitHuba w ogóle nie opuszcza karty przeglądarki. Token Cloudflare i klucz Cursora trafiają do serwera buildera, na potrzeby wywołań, których przeglądarce nie wolno wykonać, i nic nie jest potem zachowywane. Żadne dane dostępowe nie są nigdy przekazywane agentowi kodującemu: publikowanie idzie przez własną integrację Git w Cloudflare, która nie potrzebuje przekazywania tokenu — właśnie po to, żeby maszyna w chmurze nigdy nie dostała czegoś, czym da się wdrażać.

App Builder prosi Haven o jedno niezwykłe uprawnienie, Proponowanie aplikacji, które pozwala mu zaoferować właśnie zbudowaną aplikację, zamiast kazać Ci ręcznie kopiować adres URL. Potrzebuje też otwierania okien wyskakujących, bo ekrany zgody GitHuba i Cloudflare przychodzą w takim oknie. Haven i tak pyta Cię przed każdą instalacją, za każdym razem.

Sam builder jest otwartoźródłowy, a hostowana kopia jest wygodą, nie wymogiem. Jeśli wolisz, żeby klucz Cursora nigdy nie przechodził przez serwer, którego nie prowadzisz, sklonuj [`mindoodb-app-builder`](https://github.com/klehmann/mindoodb-app-builder) i uruchom go sam; wydaje się na adresie pętli zwrotnej, który liczy się jako bezpieczny origin, więc Haven po HTTPS wciąż może go osadzić. Skieruj Haven na własną kopię przez Nowa aplikacja → Z adresu URL w App Store, używając adresu pętli zwrotnej, który builder wypisuje przy starcie, zamiast instalować wpis z katalogu. To jest ta sama aplikacja, a klucz Cursora nigdy wtedy nie opuszcza Twojej maszyny.

## Synchronizacja

Synchronizacja jest tym, co utrzymuje dane w Twoich lokalnych replikach w zgodzie z serwerem. Każdy może synchronizować bazy danych, do których już ma dostęp — nie musisz być administratorem.

Ekran wymienia każdą śledzoną bazę danych w każdej lokalnej replice, którą aktywny użytkownik widzi. Wiersze są grupowane po tenancie. Dla każdego wiersza widzisz, do którego serwera, tenanta, repliki i bazy danych należy, kierunek synchronizacji (tylko wysyłanie, tylko pobieranie albo wysyłanie i pobieranie) oraz ostatni wynik synchronizacji. Na wierszach, które przynajmniej raz wcześniej się zakończyły, pojawia się mała plakietka „synchronizowana wcześniej”, co pozwala łatwo wyłowić bazy danych, które nigdy jeszcze nie były pobrane.

Tenant, który istnieje tylko na tym urządzeniu, nie ma czego wymieniać, bo nie ma jeszcze serwera, z którym mógłby się synchronizować. Zamiast go pominąć, Synchronizacja daje mu własną kartę z przyciskiem Przenieś na serwer, który otwiera to samo okno publikowania co Ustawienia → Tenanty. To jest zwykła droga od tenanta z kreatora konfiguracji do tenanta współdzielonego: karta siedzi tam, gdzie i tak szukałbyś synchronizacji, i znika, gdy tenant znajdzie się na serwerze, a jego bazy danych pojawią się jako zwykłe wiersze.

Są trzy sposoby wywołania synchronizacji. Przycisk Synchronizuj w wierszu odświeża tylko tę bazę danych. Przycisk Synchronizuj tenanta (w nagłówku każdego tenanta) odświeża każdą bazę danych w tym tenancie. Przycisk Synchronizuj wszystko u góry strony odświeża wszystko naraz. W trakcie synchronizacji kolumna statusu pokazuje postęp na żywo, w tym liczbę przesłanych partii. Zielony znacznik oznacza, że wiersz zakończył się bez błędów. Czerwona plakietka oznacza, że coś poszło źle; w takim wypadku Haven zostawia wiersz w stanie, w jakim był przed rozpoczęciem synchronizacji, więc nigdy nie zostajesz z połowicznie zastosowanymi zmianami.

Synchronizuj wszystko jest przyciskiem rozwijanym, a w jego menu jest jedna opcja warta znalezienia: Automatycznie wysyłaj zmiany na serwery. Przy włączonej opcji Haven wysyła Twoje zmiany w górę na bieżąco, zamiast czekać na następną ręczną synchronizację, co wyjmuje z dnia pracy większość pytania „czy pamiętałem o synchronizacji?”. Obejmuje wyłącznie połowę wychodzącą i jest zapamiętywana per tożsamość użytkownika, a nie per urządzenie.

Połowa przychodząca nie potrzebuje żadnego ustawienia, bo jest zawsze włączona. Dla każdego serwera i tenanta, w którym przynajmniej jeden wiersz jest ustawiony na pobieranie albo w oba kierunki, Haven trzyma otwarty żywy strumień zmian i nasłuchuje. Gdy serwer ogłasza zmianę w śledzonej przez Ciebie bazie danych, Haven pobiera ją kilka sekund później zwykłym mechanizmem synchronizacji, więc wiersz pokazuje ten sam postęp i ten sam zielony znacznik co synchronizacja, którą wywołałeś sam. Ogłoszenie nie wymusza transferu: Haven najpierw porównuje czoła, więc wiadomość o czymś, co już masz, kosztuje jedno tanie żądanie. Zerwany strumień łączy się z powrotem sam. Strumień zależy od tego samego, od czego zawsze zależy synchronizacja — od otwartej karty Haven i odblokowanej aktywnej tożsamości — a wiersze ustawione tylko na wysyłanie albo wyłączone są pomijane, bo nic w nich nie czeka na zejście w dół. Przez zwykłe połączenie serwerowe strumień przychodzi jako server-sent events; przez połączenie Iroh używa zamiast tego strumienia Iroh. Serwer zbyt stary, by oferować strumień zmian, po prostu go nie dostaje, a jego wiersze zostają na ręcznej synchronizacji.

Gdy obie połowy są na miejscu, połączenie z serwerem samo utrzymuje się w aktualności w obu kierunkach, a ręczne przyciski synchronizacji stają się tym, po co sięgasz, gdy chcesz mieć pewność w konkretnej chwili, a nie tym, co przenosi Twoje dane.

W trakcie synchronizacji pojawia się przycisk Zatrzymaj. Wysyła on bieżącemu przebiegowi sygnał zatrzymania oparty na współpracy. Bieżący wiersz ma prawo zakończyć się albo czysto wycofać, więc nie zostajesz z danymi zapisanymi w połowie. Jest jedno zastrzeżenie warte wiedzenia: jeśli naciśniesz Zatrzymaj, gdy konkretny wiersz jest w środku transferu, ten wiersz może skończyć z tylko częścią nowych danych, więc następny odczyt może mieszać świeże i stare wartości. Po zatrzymaniu uruchom ten wiersz ponownie, zanim zaufasz jakimkolwiek pochodzącym z niego liczbom.

Kiedy synchronizować? Krótka odpowiedź brzmi: przed tym, jak zaufasz liczbie, którą zamierzasz się podzielić. Uruchom synchronizację przed wygenerowaniem eksportu z widoku wirtualnego, przed wejściem na spotkanie oparte na pulpicie i za każdym razem, gdy sieci nie było dłuższą chwilę. Synchronizuj wszystko jest zawsze bezpieczne — wyłącznie pobiera nowe dane i wysyła Twoje zakolejkowane zmiany; nigdy nie usuwa pracy, której jeszcze nie zatwierdziłeś.

Jedno małe potknięcie: jeśli spodziewałeś się bazy danych w kolejce, a jej nie ma, zwykłym powodem jest to, że tożsamość użytkownika trzymająca replikę nie jest jeszcze odblokowana. Synchronizacja potrzebuje kluczy z lokalnego KeyBaga, a KeyBag otwiera się dopiero wtedy, gdy aktywna tożsamość zostanie odblokowana z górnego paska.

### Synchronizacja peer-to-peer bez serwera

Synchronizacja wcale nie musi iść przez serwer. Dwa urządzenia z Haven w tym samym tenancie mogą wymieniać dane bezpośrednio, a okazuje się, że ma to znaczenie w dwóch całkiem różnych sytuacjach. Oczywista jest awaria serwera: zespół pracuje dalej i dane dalej płyną, bo nic na tej drodze nie zależy od tego, czy serwer działa. Subtelniejsza to zwykłe pisanie wersji roboczej. Dwie osoby pracujące nad tym samym dokumentem mogą synchronizować się wprost między sobą, gdy iterują, i wypchnąć gotowy wynik na serwer raz, zamiast przeprowadzać przez niego każdy stan pośredni.

Uruchamiasz to z menu ⋮ w nagłówku tenanta na stronie synchronizacji, pod pozycją Synchronizacja peer-to-peer bez serwera. Otwierające się okno nazywa się Synchronizuj z innym urządzeniem i wymienia urządzenia tego tenanta — Twoje pod nagłówkiem Twoje urządzenia, wszystkich innych pogrupowane po członku, do którego należą. Każdy wiersz podaje etykietę urządzenia, jego Punkt końcowy, jego Klucz podpisujący i to, czy jest w tej chwili osiągalne. Wybierz jedno i naciśnij Dodaj urządzenie.

Urządzenie po drugiej stronie musi się Ciebie spodziewać. W Ustawienia → Ogólne jest karta o nazwie Synchronizacja między urządzeniami z jednym polem wyboru: Akceptuj przychodzącą synchronizację urządzeń. Włączenie go pozwala innym urządzeniom tego tenanta synchronizować się bezpośrednio z tym — również urządzeniom należącym do innych członków, nie tylko Twoim własnym. Idą z tym dwa warunki. Nasłuch istnieje wyłącznie wtedy, gdy karta Haven jest otwarta, a sesja musi być odblokowana; karta stojąca na oknie odblokowania odpowiada, ale odmawia synchronizacji, i dokładnie to Haven zgłasza wtedy drugiej stronie.

To, co czyni urządzenia znajdywalnymi, jest identyfikator punktu końcowego. Haven generuje jeden na urządzenie przy pierwszym starcie i publikuje go w bazie danych katalogu użytkowników tenanta — a właśnie stamtąd okno Synchronizuj z innym urządzeniem czyta swoją listę, i dlatego może pokazać Ci czytelną nazwę użytkownika i etykietę urządzenia, a nie sam identyfikator. Publikowanie odbywa się niezależnie od tego, czy akceptujesz przychodzącą synchronizację, i to celowo: cała rzecz w tym, żeby urządzenia mogły się nadal znajdować, gdy serwer nie działa i nic nowego nie da się opublikować. Odwrotną stroną jest to, że urządzenie wie tylko o tych peerach, których wpis katalogowy już pobrało, więc tenant, który nigdy nie był na tym urządzeniu synchronizowany, nie ma jeszcze nikogo do zaoferowania.

Pod spodem działa to na sieci Iroh. W przeglądarce Haven dosięga drugiego urządzenia przez relay Iroh — to konsekwencja tego, co wolno robić stronie internetowej z siecią, a nie preferencja projektowa — natomiast natywna wersja Haven może połączyć się bezpośrednio, gdy oba urządzenia siedzą w tej samej sieci. Ten sam transport jest dostępny między klientem a serwerem, jeśli serwer MindooDB został skonfigurowany do przystąpienia do Iroh; tę stronę konfiguracji omawia [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md).

Ten przypadek klient-serwer wart jest drugiego spojrzenia, bo zmienia to, czym musi być serwer. Osiągany po HTTP serwer musi być osiągalny: nazwa hosta, certyfikat i port, który coś w internecie ma prawo otworzyć. Przez Iroh nic z tego nie obowiązuje. Serwer może siedzieć w sieci, do której nic nie umie zadzwonić — maszyna w domu za routerem z NAT, bez przekierowanego portu — a Haven i tak do niego dotrze, bo żadna ze stron nie musi przyjmować połączenia przychodzącego: znajdują się przez relay, który albo pomaga im otworzyć bezpośrednią ścieżkę, albo sam niesie ruch, gdy router na taką ścieżkę nie pozwoli. W miejsce adresu `https://` wpisujesz lokator `iroh:`, który serwer wypisuje przy starcie, i synchronizacja działa jak zwykle, wraz z żywym strumieniem zmian. Relay na drodze widzi nie więcej niż serwer: przechodzi przez niego szyfrogram, a relay dowiaduje się tylko, że dwa punkty końcowe rozmawiają.

Gdy inne urządzenia synchronizują się z Twoim, na stronie synchronizacji wyrasta panel z nagłówkiem Przychodząca synchronizacja peer-to-peer i liczbą sesji, wymieniający, które urządzenie co przesłało i w którym kierunku. Jest czyszczony przy przeładowaniu i jest miejscem, do którego zaglądasz, gdy chcesz potwierdzić, że bezpośrednia synchronizacja naprawdę się odbyła.

## Szybki skan

Szybki skan to skaner dokumentów wbudowany w Haven, który zamienia kartkę papieru w czysty plik, i nic przy tym nie opuszcza karty przeglądarki. Otwórz go ze Startu i pojawi się jako nakładka na obszarze roboczym, a nie ekran, z którego musisz nawigować z powrotem.

Skieruj kamerę na stronę albo wybierz obraz, który już masz. Haven znajduje krawędzie kartki, koryguje perspektywę, żeby wynik wyglądał jak skan, a nie jak zdjęcie zrobione pod kątem, i pozwala potem wyprostować, przyciąć i obrócić. Jeśli automatyczne wykrywanie krawędzi wybierze zły prostokąt — wzorzysty obrus to załatwi — przeciągnij narożniki sam albo naciśnij Wykryj krawędzie ponownie, żeby spróbować jeszcze raz. Ustawienia strony, takie jak A4 i Letter, utrzymują sensowne proporcje wyniku.

Skan nie musi być jedną kartką. Naciśnij Dodaj stronę i sfotografuj następną, i tak dalej, aż stos się skończy. Pasek miniatur z boku pokazuje strony, które już masz, i numeruje je; wybierz jedną, aby ją obrócić, albo odrzuć ją i sfotografuj tę stronę ponownie. Skan wielostronicowy wychodzi jako jeden plik PDF, a jedna strona może być też plikiem PNG albo JPEG. Jest też akcja Wyodrębnij tekst, która uruchamia OCR na stronie, gdy chcesz słowa, a nie obrazek.

Wszystko to odbywa się w karcie przeglądarki. Szybki skan działa offline, nic nie jest przesyłane do żadnej usługi w celu przetworzenia, a obraz nie opuszcza urządzenia inaczej niż przez pobranie albo udostępnienie, które sam wybierzesz.

Czego Szybki skan nie robi, to odłożenie wyniku na miejsce za Ciebie. Ma dwa wyjścia — przycisk pobierania i systemowy arkusz udostępniania — i oba wydają Ci plik; nic nie jest zapisywane do bazy danych. Gdy chcesz, żeby skan wylądował wewnątrz dokumentu, uruchom go z tego, co ten dokument posiada. Przeglądarka baz danych skanuje bezpośrednio do otwartego dokumentu, a aplikacja może otworzyć ten sam skaner przez App SDK i dołączyć wynik do jednego ze swoich dokumentów. We wszystkich trzech miejscach to ten sam skaner i ta sama korekcja perspektywy; różni się tylko ostatni krok.

## Widoki wirtualne

Widoki wirtualne są analityczną powierzchnią Haven. Dają Ci drzewo w stylu arkusza kalkulacyjnego, które filtruje, kategoryzuje, sortuje i podsumowuje dokumenty z jednej bazy danych, z kilku baz danych, a nawet z kilku tenantów. To nimi odpowiadasz na pytania przekrojowe wobec swoich danych, a nie tylko na pytania wewnątrz jednej bazy danych.

Mają drugie zadanie, które łatwo przeoczyć: widok jest dobrym źródłem danych dla aplikacji. Przyznanie aplikacji całej bazy danych jest czasem więcej, niż aplikacja potrzebuje, i więcej, niż chcesz wydać. Zbuduj widok, który wystawia dokładnie te dokumenty i kolumny, na których aplikacja ma pracować, zmapuj aplikację na widok zamiast na bazę danych, i aplikacja dostanie to, czego potrzebuje, a reszta zostanie poza zasięgiem.

Ekran Widoki wirtualne ma dwie części: katalog zapisanych widoków u góry i płótno buildera, które otwiera się pod nim, gdy wybierzesz albo utworzysz widok. Katalog oferuje Nowy widok, Otwórz widok, Edytuj widok, Duplikuj widok i Usuń widok, plus przyciski Importuj i Eksportuj do przenoszenia definicji widoków między środowiskami. Każdy wiersz pokazuje nazwę widoku i jego źródła danych.

Płótno buildera jest miejscem, w którym widok jest właściwie komponowany. U góry nadajesz widokowi nazwę, opcjonalny opis i styl kategoryzacji (na przykład kategorie przed dokumentami). Pod tym przychodzi sekcja Źródła, w której każde źródło dostaje etykietę pochodzenia (żeby wiersze w wyniku mogły Ci powiedzieć, z której bazy danych przyszły) i jest połączone z tenantem i bazą danych. Pod Źródłami jest lista kolumn, w której dodajesz kolumny kategorii, kolumny sortowane i kolumny podsumowujące, albo wizualnym builderem dla typowych przypadków, albo małym fragmentem kodu w piaskownicy dla zaawansowanych obliczeń. Podgląd na żywo odbudowuje się na bieżąco, więc od razu widzisz wpływ każdej zmiany.

Każde źródło może czytać z lokalnej repliki albo z żywego źródła zdalnego. Źródła z lokalnej repliki są najszybsze i działają offline; źródła żywe pobierają świeże dane z serwera przed indeksowaniem, co jest wolniejsze, ale daje najnowszy stan po stronie serwera. Jeden widok może mieszać oba rodzaje. Domyślnie używaj źródeł z lokalnej repliki i przełączaj pojedyncze na żywe tylko wtedy, gdy świeżość liczy się bardziej niż szybkość.

Ponieważ widok może obejmować miliony wierszy, Haven indeksuje go lokalnie i przyrostowo. Każdy zapisany widok ma własny zmaterializowany indeks w tej przeglądarce. Z nagłówka widoku możesz wstrzymać bieżące zadanie indeksowania na najbliższym czystym punkcie kontrolnym, wznowić je od miejsca, w którym stanęło, albo odbudować je od zera. Wstrzymanie i wznowienie wystarczają w niemal każdej sytuacji; odbudowa jest potrzebna tylko po zmianie kolumn albo źródeł widoku, bo te zmiany unieważniają pamięć podręczną. Odbudowa poza tymi przypadkami wyrzuca pracę, którą pamięć podręczna mogłaby wykorzystać ponownie.

W drzewie wyników możesz rozwijać kategorie, wchodzić w dokumenty i budować zaznaczenie polami wyboru. Zaznaczenie kategorii zaznacza niejawnie każdy widoczny dokument potomny pod nią. Eksportuj .xlsx produkuje prawdziwy arkusz .xlsx: zachowuje pasujące wiersze kategorii nad zaznaczonymi dokumentami i zawiera zarówno metadane źródła, jak i wszystkie obliczone kolumny widoku, więc możesz przekazać plik wprost narzędziu niezwiązanemu z MindooDB.

## Przeglądarka baz danych i eksplorator DAG

Przeglądarka baz danych służy do zaglądania w głąb jednej bazy danych. To tam wymieniasz dokumenty, przeglądasz historię, porównujesz obok siebie dowolne dwie rewizje i edytujesz tę żywą. Jest najprzydatniejszym ekranem, gdy debugujesz dane, sprawdzasz, co się zmieniło, albo wyciągasz załącznik z konkretnej rewizji.

Lista dokumentów ma trzy tryby: Wszystkie, Istniejące i Usunięte. Pole filtra przyjmuje jeden identyfikator, identyfikatory rozdzielone przecinkami albo po jednym identyfikatorze w wierszu, co jest wygodne, gdy masz listę identyfikatorów od kolegi albo ze skryptu. Każdy wiersz pokazuje bieżącą rewizję plus małą plakietkę przy dokumentach, które mają jeszcze otwartą historię.

Kliknięcie dokumentu rozwija jego pełną historię rewizji, od najnowszej. Historia zawiera żywą bieżącą rewizję, każdą poprzednią rewizję oraz zdarzenie usunięcia tam, gdzie takie było. Przy dużych historiach wiersze ładują się partiami; przewijanie wewnątrz rozwiniętego panelu dociąga kolejne.

Porównanie obok siebie jest jedną z najprzydatniejszych sztuczek przeglądarki. Wybierz jeden wiersz historii do lewego panelu i drugi do prawego, a Haven podświetli dokładnie to, które pola się zmieniły. Zaznaczenie jest wspólne dla całej strony, więc możesz porównać dwie rewizje tego samego dokumentu albo dwa całkowicie różne dokumenty. To jest najprostszy sposób na potwierdzenie, co właściwie zrobiła automatyczna zmiana, przed ręcznym scaleniem czegokolwiek.

Edycja jest dozwolona wyłącznie na żywej bieżącej rewizji. Rewizje historyczne i usunięte z założenia zostają ściśle tylko do odczytu — Haven nie pozwoli Ci nadpisać historii. Załączniki natomiast można pobrać z każdej rewizji, także z usuniętych, więc da się odzyskać plik, który kiedyś był dołączony, a potem został usunięty.

Każdy panel, filtr i porównanie odbija się w adresie URL, więc zakładka albo udostępniony link przywraca Cię do tego samego widoku.

Gdy zwykła lista rewizji nie wystarczy, by wyjaśnić, co się stało, otwórz eksplorator DAG. To graficzne przedstawienie każdego podpisanego wpisu cyklu życia, jaki kiedykolwiek zastosowano do dokumentu. Czas biegnie od lewej do prawej: każdy węzeł to jeden podpisany wpis, a krawędzie pokazują, jak wpisy następowały po sobie. Gałęzie pojawiają się, gdy dwie osoby edytowały dokument w tym samym czasie, i spotykają się znów w węźle scalenia, gdy następna synchronizacja złożyła ich pracę razem.

Każdy węzeł jest opisany rodzajem wpisu, który reprezentuje. Utworzenie oznacza pierwszy wpis dokumentu. Zmiana to zwykła edycja, która dotknęła pól albo załączników. Usunięcie to wpis nagrobny — poprzednia treść jest zachowana, zmienia się tylko stan cyklu życia. Przywrócenie odtwarza usunięty dokument i wskazuje z powrotem na wpis Usunięcia, który odwraca. Węzły Migawki to okresowe migawki kompaktujące i są tu tylko do odczytu; nie możesz ich kliknąć, żeby zmaterializować osobną gałąź.

Najechanie na węzeł pokazuje, kto dokonał zmiany, kiedy, z którego urządzenia i których pól dotknął. Kliknięcie węzła niebędącego migawką materializuje dokument w takiej postaci, w jakiej istniał na tej gałęzi, i pokazuje wynik w panelu Zmaterializowany stan, wraz z załącznikami, które istniały w tamtym momencie. Haven albo użyje ponownie pobliskiej migawki, albo odtworzy łańcuch wpisów od korzeni gałęzi — i powie ci, którą z tych dróg wybrał. Drugi panel, Analiza konfliktów, wymienia ścieżki konfliktów dołączone do wybranego wpisu, bo silnik Automerge w MindooDB rozstrzyga równoległe edycje deterministyczną regułą, a nie zgadywaniem.

Niczego w eksploratorze DAG nie da się edytować. Jest to wierny, tylko do odczytu zapis historii. To jest też to, co czyni go przydatnym na potrzeby zgodności: każdy węzeł jest podpisany przez użytkownika, który dokonał zmiany, więc jest źródłem prawdy, gdy audytor pyta, kto to zmienił i kiedy.

## Ustawienia

Ustawienia są jedynym ekranem zorganizowanym jako pasek kart, a nie jedna strona. Mają sześć kart: Ogólne, Identyfikatory użytkowników, Tenanty, Kopia zapasowa, Przywracanie i Statystyki. Wszystko na tych kartach leży w tej przeglądarce, z kilkoma celowymi wyjątkami: akcjami na karcie Tenanty, włączanym opcjonalnie ustawieniem Przenoszony obszar roboczy oraz punktem końcowym, który publikuje Synchronizacja między urządzeniami, żeby inne urządzenia mogły znaleźć to.

### Ogólne

Ogólne są miejscem, w którym dostosowujesz wygląd Haven i sposób jego uruchamiania na Twoim urządzeniu. Wszystko jest osobiste i działa natychmiast — nie ma przycisku zapisu.

U góry Język wyświetlania ustawia język, którym mówi sam Haven — jego nawigacja, ustawienia, okna dialogowe i pomoc. Nie dotyka Twoich dokumentów, a aplikacje działające w Haven przynoszą własne tłumaczenia.

Bieżący motyw pozwala wybrać zestaw kolorów (na przykład Mindoo albo Aura) i przełączać się między trybem jasnym i ciemnym. Zestaw zmienia kolory akcentu w całej aplikacji; przełącznik jasny/ciemny steruje tłem i kontrastem tekstu. Ten sam wybór motywu odbija się w menu prawego przycisku na plakietce tożsamości i jest przekazywany na żywo każdej osadzonej aplikacji MindooDB, żeby dopasowała się do wyglądu Haven bez przeładowania.

Dodaj Haven do ekranu głównego to karta na jedno dotknięcie, która oferuje skrót do instrukcji instalacji dla Twojej platformy. Na iPhonie prowadzi do przebiegu „Dodaj do ekranu początkowego” w Safari; na Androidzie wywołuje przebieg instalacji przeglądarki albo wskazuje Ci akcję instalacji aplikacji w menu przeglądarki. Jeśli Haven działa już z zainstalowanej ikony, karta po prostu to potwierdza i pokazuje przycisk Zobacz kroki instalacji, gdybyś chciał dodać kolejną kopię.

Przełącznik Optymalizuj dla wielozadaniowości iOS mówi Haven, że jest używany w trybie podzielonego ekranu albo slide over na iPadzie, gdzie system dodaje elementy okna nachodzące na własne elementy Haven. Włączenie go odsuwa elementy Haven od nich. Pod nagłówkiem Ruch opcja Ogranicz animacje usuwa przejścia Haven dla każdego, kogo rozpraszają albo kogo system już prosi o mniej ruchu.

Synchronizacja między urządzeniami jest miejscem, w którym leży odbiorcza połowa synchronizacji peer-to-peer. Polem wyboru jest Akceptuj przychodzącą synchronizację urządzeń, a karta pokazuje też punkt końcowy tego urządzenia — identyfikator, pod który dzwonią inne urządzenia, żeby do niego dotrzeć — wraz z tym, czy ktokolwiek może je w tej chwili zobaczyć. Co robią obie strony, wyjaśnia sekcja o synchronizacji peer-to-peer pod Synchronizacją; to jest przełącznik, który czyni to urządzenie jedną z nich.

Przenoszony obszar roboczy to jedyne ustawienie na tej karcie, które opuszcza przeglądarkę, i jest wyłączone, dopóki go nie włączysz. Sprawia, że strony obszaru roboczego, kafelki, grupy i lista aplikacji aktywnego identyfikatora użytkownika idą za Tobą na Twoje inne urządzenia, i pozwala trzymać kilka środowisk oraz przełączać się między nimi — biuro i dom albo komputer i urządzenie mobilne. Jest to funkcja Haven Enterprise: bez aktywnej licencji przełącznik zostaje wyłączony, to urządzenie ani nie zapisuje swojego obszaru roboczego, ani nie przejmuje żadnego, a środowiska założone wcześniej zostają dokładnie takie, jakie są, dopóki licencja nie zostanie ponownie zaimportowana. Włączenie przełącznika odsłania dwa pola: tenanta, przez którego obszar roboczy jest synchronizowany, i nazwę zapisanego obszaru roboczego. Nazwa jest tym, po czym urządzenia się znajdują, więc „biuro” na Twoim laptopie i „biuro” na Twoim telefonie dzielą jeden obszar roboczy; pole otwiera listę rozwijaną nazw już zapisanych dla tego identyfikatora użytkownika, a wpisanie nazwy, której na tej liście nie ma, zaczyna nową. Żadne z pól nie działa w trakcie edycji — Zastosuj zatwierdza oba, Anuluj przywraca to, co obowiązuje. Co robi Zastosuj, wynika z nazwy: nowa jest tworzona z obszaru roboczego tego urządzenia, istniejąca jest przejmowana, a ułożone tutaj karty i kafelki są przez nią zastępowane. To zastąpienie kosztuje Cię coś tylko wtedy, gdy przenoszenie było wyłączone, więc to jedyny przypadek, o który Haven najpierw pyta; gdy przenoszenie jest włączone, stan tego urządzenia leży już w jego zapisanym obszarze roboczym, a przejście na inną nazwę jest darmowe. Wyłączenie przełącznika zatrzymuje przenoszenie od razu i zostawia każdy zapisany obszar roboczy nietknięty.

Podróżuje wyłącznie układ: strony i ich kolejność, każdy kafelek ze swoim położeniem i rozmiarem, grupy, ustawienia siatki i sortowania oraz Twoje rejestracje aplikacji. To, co zostaje lokalnie, jest celowo pominięte — na przykład strona, na którą właśnie patrzysz, żeby drugie urządzenie nie mogło szarpnąć Twoim widokiem. Aplikacje, które Twój administrator tenanta rozprowadza polityką, są też pominięte, bo każde urządzenie i tak dostaje je z katalogu tenanta.

Zapisany obszar roboczy jest zwykłym dokumentem MindooDB w katalogu użytkowników tenanta, zaszyfrowanym tylko dla Ciebie — koledzy z zespołu i administratorzy synchronizują jego bajty jak wszystko inne i nie przeczytają z niego ani słowa, a zmienić go albo usunąć mogą wyłącznie Twoje własne urządzenia. Ponieważ jest dokumentem, podróżuje dokładnie tak, jak podróżują Twoje dane: zmiana jest zapisywana lokalnie i dociera do drugiego urządzenia przy następnej synchronizacji, więc oba urządzenia muszą dosięgać serwera, a nie siebie, i żadne nie musi być otwarte w tym samym czasie. Dwa urządzenia edytujące jednocześnie scalają się, a nie nadpisują — przeniesienie kafelka tutaj i zmiana nazwy strony tam zachowują obie zmiany, a ten sam kafelek przeciągnięty na obu urządzeniach ustala się na jednym położeniu. Możesz trzymać kilka zapisanych obszarów roboczych na identyfikator użytkownika, śledzić po jednym na urządzenie i usunąć jeden na dobre z tej samej karty; urządzenia, które go śledziły, po prostu przestają przenosić i zachowują układ, jaki mają. Lista pozostaje widoczna przy wyłączonym przenoszeniu i obejmuje każdego tenanta, którego ten identyfikator użytkownika dosięga, więc każdy wpis nazywa swojego tenanta obok nazwy zapisanego obszaru roboczego i podaje, kiedy był ostatnio zapisany przez to z Twoich urządzeń, które go zapisało — obszar roboczy, którego nikt nie dotknął od miesięcy, łatwo wyłowić przed usunięciem.

### Identyfikatory użytkowników

Tożsamość użytkownika jest Twoim kontem w Haven, a ta karta jest miejscem, w którym zarządzasz przechowywanymi tożsamościami. Każdy wiersz to jedna tożsamość z jej nazwą użytkownika, tym, czym się odblokowuje, i datą utworzenia; tożsamości administracyjne są oznaczone znacznikiem Administrator, żeby łatwo je odróżnić od zwykłych użytkowników. Akcja przełączenia czyni tę tożsamość aktywną dla tej sesji Haven — dla tożsamości z kluczem dostępu jest to jeden przycisk i prośba o Face ID zamiast wpisywanego hasła. Tylko jedna tożsamość jest odblokowana naraz; jeśli coś na innym ekranie skarży się, że nie może przeczytać tenanta, zwykle odblokowana jest niewłaściwa tożsamość.

Utwórz generuje zupełnie nową tożsamość wprost w przeglądarce i daje ten sam wybór klucza dostępu albo hasła co kreator powitalny. Importuj wciąga plik .json, który został wcześniej wyeksportowany z Haven albo utworzony w konsoli MindooDB (na przykład na innym urządzeniu albo przez kogoś z zespołu), i pyta o hasło użyte przy eksporcie pliku.

Kolumna Odblokowanie mówi Ci, które sekrety otwierają w tej chwili tożsamość, i jeden przycisk to zmienia: Opcje logowania. Powtarza, co otwiera wybraną tożsamość dzisiaj, a potem oferuje tylko te zmiany, które do niej pasują: tożsamości, która ma już hasło, nie proponuje się drugiego, a tożsamość bez klucza dostępu nie ma czego usuwać, więc lista ma dwa albo trzy wpisy, a nie ścianę wyszarzonych przycisków. Wyjątkiem jest akcja, która pasuje do tożsamości, ale którą blokuje reguła — ta zostaje na liście, z powodem wpisanym w miejsce opisu, bo powód jest zwykle drogą dalej. Tożsamość administratora mówi, dlaczego zostaje chroniona tylko hasłem, a Usuń hasło przy tożsamości, która nie ma jeszcze klucza dostępu, mówi, żeby najpierw go dodać, zamiast po prostu odmówić.

Dodaj klucz dostępu rejestruje uwierzytelniacz tego urządzenia dla tożsamości, która miała tylko hasło; Twoje hasło działa dalej dokładnie tak jak wcześniej, więc jest to bezpieczna rzecz do zrobienia na każdym urządzeniu, którego używasz. Usuń klucze dostępu usuwa zarejestrowane uwierzytelniacze. Dodaj hasło robi rzecz odwrotną i ma znaczenie głównie przy eksportach: konsola i SDK działają w Node, gdzie nie ma uwierzytelniacza, o który można zapytać, więc tożsamości chronionej wyłącznie kluczem dostępu nie da się otworzyć poza tą przeglądarką. Jeśli poprosisz o pełny eksport tożsamości chronionej wyłącznie kluczem dostępu, Haven nie wyszarza pozycji menu — pyta najpierw o hasło, dodaje je obok klucza dostępu i wtedy zapisuje plik. Nic nie jest przy tym szyfrowane ponownie; tożsamość po prostu zyskuje drugie wejście.

Usuń hasło jest opcją do dwukrotnego przemyślenia. Zostawia tożsamość, którą otwiera wyłącznie jej klucz dostępu, co jest mocniejszym układem — nie zostaje żaden wpisywany sekret, który da się wyłudzić, użyć ponownie albo zapomnieć — ale zawęża też drogi powrotne do jednej. Haven odmawia wprost, o ile nie jest zarejestrowany klucz dostępu, bo tożsamość bez żadnej metody odblokowania jest nieodzyskiwalna: klucz, który otwiera klucze prywatne, istnieje wyłącznie wewnątrz tych opakowań. Nawet z kluczem dostępu na miejscu trzymaj zaszyfrowaną kopię zapasową: klucz dostępu, który się nie synchronizuje, żyje w tym jednym uwierzytelniaczu, a plik kopii zapasowej jest tym, co zamienia zgubiony laptop w „przywróć i wpisz hasło kopii zapasowej” zamiast w utraconą tożsamość. Pełny eksport tożsamości zostaje zablokowany, dopóki nie istnieje hasło, z powodów związanych z Node opisanych wyżej, a dodanie go z powrotem jest o jedno dwupolowe okno dialogowe stąd.

Zmień hasło siedzi na tej samej liście. Dla tożsamości, której metody odblokowania są opakowaniami wokół wewnętrznego klucza — czyli wszystkiego utworzonego niedawno i wszystkiego, co kiedykolwiek miało klucz dostępu — Haven wymienia wyłącznie opakowanie hasła, więc każdy zarejestrowany klucz dostępu zostaje ważny i żaden KeyBag nie musi być odbudowywany. Dla starszej tożsamości, której hasło szyfruje klucze prywatne bezpośrednio, Haven szyfruje ponownie te klucze i zależne od nich KeyBagi tenantów w jednym kroku, więc nowe hasło działa od razu wszędzie. Tak czy inaczej wybierz mocne hasło i zapisz je tam, gdzie je potem znajdziesz, bo nie ma linku resetującego: jeśli zapomnisz nowego hasła, każdy tenant powiązany z tą tożsamością staje się nieczytelny, nawet na urządzeniach, które już miały dane. Zapisz je w menedżerze haseł przed naciśnięciem Zapisz.

Jeśli tożsamość została utworzona z hasłem, zanim istniały klucze dostępu, Haven zaproponuje dodanie klucza przy następnym odblokowaniu. Przyjęcie propozycji zajmuje jedną prośbę o Face ID i zostawia hasło na miejscu jako zapas. Wybór opcji Nadal używaj hasła jest odpowiedzią trwałą dla tego urządzenia: Haven ją pamięta i nigdy więcej nie zapyta o tę tożsamość, a Opcje logowania na tej karcie zostają dostępne, gdybyś zmienił zdanie. Zamknięcie okna krzyżykiem albo klawiszem Escape tylko odkłada pytanie, więc możesz zdecydować przy następnym odblokowaniu. Ponowne usunięcie klucza dostępu też liczy się jako odpowiedź — Haven nie zacznie potem proponować go przy każdym odblokowaniu.

Pod tabelą tożsamości, gdy tożsamość jest odblokowana, sekcja „Twoje urządzenia” wymienia każde urządzenie, które trzyma — albo czeka, by trzymać — klucz użytkownika tej osoby, po jednym wierszu na urządzenie i tenanta, z akcją „Zatwierdź” albo „Mimo to zezwól” tam, gdzie wolno Ci jej użyć. To jest panel stojący za przebiegiem zatwierdzania opisanym w sekcji o używaniu Haven na więcej niż jednym urządzeniu i miejsce, do którego idziesz, gdy zbyt szybko zamknąłeś okno zatwierdzania.

### Tenanty

Tenant jest prywatnym obszarem roboczym Twojego zespołu, a ta karta wymienia każdego tenanta, o którym Haven wie dla aktywnej tożsamości użytkownika. Dla każdego wiersza widzisz identyfikator tenanta, bieżącego użytkownika, użytkownika administracyjnego oraz serwery, na których tenant został opublikowany.

Otwarcie tenanta pokazuje odciski jego kluczy i miejsce, w którym jest w tej chwili opublikowany. Odciski pochodzą z lokalnego KeyBaga aktywnego użytkownika, więc pojawiają się dopiero po odblokowaniu tego użytkownika. Traktuj odciski jako dowód tożsamości kluczy szyfrujących tenanta: jeśli dwie osoby z zespołu porównają je osobiście i będą zgodne, możesz być pewien, że nikt po drodze nie podmienił klucza.

Akcje dotykające katalogu tenanta — publikowanie tenanta albo przyznanie komuś z zespołu dostępu na podstawie żądania dołączenia — są podpisywane tożsamością administratora, więc Haven pyta o jej frazę hasłową. Ponieważ takie zadania zwykle przychodzą partiami, prośba oferuje odblokowanie administratora na tę sesję: zaznacz to raz i kolejne kroki przestaną pytać. Odblokowanie administratora w ten sposób nie przełącza Twojej aktywnej tożsamości, więc pracę na dokumentach nadal wykonuje Twój codzienny użytkownik, a akcja Zablokuj administratora ponownie kończy to wcześniej, gdy skończysz.

Nowe tenanty zawsze zaczynają w tej przeglądarce dla aktywnego użytkownika. Publikowanie wypycha tenanta na serwer MindooDB, żeby inni członkowie zespołu mogli dołączyć; strona synchronizacji oferuje ten sam krok jako przycisk Przenieś na serwer, dopóki tenant istnieje tylko lokalnie, więc większość ludzi spotyka go najpierw tam. Usunięcie z serwera usuwa lokalizację tenanta wyłącznie z tego serwera — kopia lokalna zostaje na miejscu. Publikowanie i usuwanie na serwerze wymagają hasła administratora systemu, bo dotykają współdzielonej infrastruktury; jeśli nie jesteś administratorem platformy, poproś go, żeby wykonał akcję razem z Tobą.

Ostrożnie z usuwaniem na serwerze. Wymazuje ono widok tego serwera na tenanta dla każdego użytkownika, nie tylko dla Ciebie, a inni klienci mogą nagle przestać się synchronizować. Potwierdź to najpierw z administratorem platformy i pozostałymi administratorami zespołu i upewnij się, że istnieje aktualna zaszyfrowana kopia zapasowa, przed naciśnięciem przycisku.

### Kopia zapasowa

Haven trzyma niemal wszystko w tej przeglądarce. Karta Kopia zapasowa jest siatką bezpieczeństwa i oferuje dwie bardzo różne siatki: zaszyfrowany plik, który zawiera wszystko, oraz papierowy wydruk, który potrafi przywrócić jednego tenanta z niczego. Odłożenie jednego albo drugiego z powrotem — i wymazanie Haven — odbywa się na karcie Przywracanie obok.

Zaszyfrowana kopia zapasowa to jeden plik zawierający wszystko, co Haven trzyma w tej przeglądarce: zapisanych użytkowników, tenanty, aplikacje, pliki hostowanych aplikacji, układ obszaru roboczego, widoki wirtualne i lokalną zawartość IndexedDB. Wybierasz hasło kopii zapasowej, a Haven używa go do zaszyfrowania pliku przed pobraniem. Na cały plik jest dokładnie jedno hasło kopii zapasowej, niezależnie od tego, ile tożsamości jest w środku. Samo hasło nie jest nigdzie przechowywane — Haven nie może Ci go później pokazać i nie może pomóc Ci odzyskać kopii zapasowej, jeśli je zgubisz. Pobrania mają rozszerzenie .mdbhaven-backup, żeby łatwo je wyłowić w folderze pobrań.

Tożsamości odblokowywane kluczem dostępu wymagają jednego dodatkowego przemyślenia, bo klucz dostępu nie może opuścić urządzenia, które go trzyma — to jest cały sens klucza dostępu i dlatego przywrócenie na nowym laptopie inaczej wydałoby Ci tożsamość, której nikt nie potrafi otworzyć. Haven rozwiązuje to wewnątrz pliku, a nie osłabiając Twoje urządzenie: dla każdej tożsamości chronionej wyłącznie kluczem dostępu dodaje kopię klucza odblokowującego, która otwiera się Twoim hasłem kopii zapasowej. Twoja lokalna tożsamość zostaje nietknięta i zachowuje swój klucz dostępu. Jeśli którakolwiek z tych tożsamości jest w tej chwili zablokowana, Haven poprosi raz o klucz dostępu w trakcie przygotowywania pobrania. Praktyczna konsekwencja jest taka, że hasło kopii zapasowej jest tak samo wartościowe jak tożsamości w pliku: traktuj je jak klucz główny i odpowiednio przechowuj.

Drugą kartą na tej zakładce jest wydruk awaryjny tenanta i odpowiada on na inne pytanie: co przeżyje, gdy nie przeżyje żadna przeglądarka. Obejmuje jednego tenanta naraz i zawiera wyłącznie to, czego nie da się pobrać ponownie — wybrane przez Ciebie tożsamości użytkownika i administratora, ich klucze z KeyBaga, adres serwera i konfigurację synchronizacji — tak żeby późniejsza synchronizacja mogła sprowadzić z serwera same dokumenty. Celowo nie zawiera danych dokumentów, co oznacza też, że jest bezużyteczny dla tenanta, który nigdy nie został opublikowany. Wybierasz pytanie zabezpieczające, które jest drukowane na arkuszu, i odpowiedź, która nie jest; odpowiedź jest tym, co odszyfrowuje arkusz później. Haven rozkłada następnie zaszyfrowany ładunek na osiem kodów QR z taką redundancją, że wystarczy dowolnych sześć z nich, więc plama po kawie albo oderwany narożnik nie kosztują Cię tenanta. Przechowuj go tam, gdzie trzymasz paszporty, nie tam, gdzie trzymasz wydruki.

### Przywracanie

Karta Przywracanie jest miejscem, w którym kopia zapasowa wraca i w którym da się wymazać Haven, gdy nic innego nie pomaga.

Przywracanie zaszyfrowanego pliku kopii zapasowej odbywa się w dwóch krokach i oba są celowe. Pierwszy krok, Podgląd, odszyfrowuje plik tylko na tyle, by pokazać Ci podsumowanie tego, co jest w środku: liczby tożsamości, tenantów, aplikacji, baz danych IndexedDB oraz wszelkie ostrzeżenia przywracania. Nic lokalnego nie jest jeszcze dotykane. Niektóre kopie zapasowe zawierają bazy danych, których nie da się przenieść między przeglądarkami w niezmienionej postaci; podgląd pokazuje ostrzeżenie dla każdej takiej bazy danych wraz z informacją, czy zostanie odbudowana pusta, czy pominięta. Odbudowa oznacza, że baza danych zostanie utworzona pusta i wypełniona ponownie z synchronizacji. Pominięcie oznacza, że nie zostanie przywrócona wcale i będziesz musiał ręcznie podłączyć to źródło od nowa.

Drugi krok, Przywróć i załaduj ponownie, wymazuje bieżący stan Haven w tej przeglądarce i zapisuje kopię zapasową z powrotem. Haven przeładowuje się automatycznie i kończysz zalogowany do przywróconych danych. Ponieważ przywracanie najpierw usuwa bieżący stan, wszystko, co nie zostało wyeksportowane ani zsynchronizowane, zniknie. Wyeksportuj świeżą zaszyfrowaną kopię zapasową bieżącego stanu przed naciśnięciem Przywróć, na wszelki wypadek.

Po przywróceniu na innym urządzeniu albo w innej przeglądarce tożsamości, które kiedyś odblokowywały się kluczem dostępu, poproszą zamiast tego o hasło kopii zapasowej, a okno odblokowania o tym mówi. Klucz dostępu został na starym urządzeniu, więc jest to oczekiwane, a nie znak, że coś poszło źle. Odblokuj tożsamość raz hasłem kopii zapasowej, a potem użyj Dodaj klucz dostępu, aby zarejestrować uwierzytelniacz nowego urządzenia; od tego momentu tożsamość zachowuje się dokładnie tak jak wcześniej.

Przywracanie z wydruku awaryjnego tenanta korzysta z drugiej karty i tej samej dwustopniowej ostrożności. Zeskanuj kody QR kamerą urządzenia albo wklej ich zawartość, odpowiedz na pytanie zabezpieczające, a Haven odłoży z powrotem tożsamości, materiał z KeyBaga, adres serwera i konfigurację synchronizacji. Nic innego nie podróżuje na papierze, więc uruchom potem synchronizację, aby ściągnąć dokumenty tenanta z powrotem. To jest też droga powrotna, gdy zniknęło każde zatwierdzone urządzenie tenanta i nie zostaje nikt, kto mógłby zatwierdzić nowe.

Przywracanie ustawień fabrycznych jest na dole karty. Wymazuje wszystko, o czym Haven wie w tej przeglądarce — tożsamości, tenanty, aplikacje, pliki hostowanych aplikacji, widoki wirtualne, układ obszaru roboczego i wszystkie zsynchronizowane dane MindooDB — i przywraca Haven do stanu zupełnie nowego. Ponieważ jest nieodwracalne, Haven prosi Cię o wpisanie frazy potwierdzającej, zanim przycisk stanie się aktywny, a potem prosi przeglądarkę o jeszcze jedno potwierdzenie. Traktuj przywracanie ustawień fabrycznych jako ostatnią deskę ratunku i tylko po upewnieniu się, że istnieje sprawdzona kopia zapasowa.

### Statystyki

Karta Statystyki pokazuje, ile miejsca Haven zajmuje w tej przeglądarce, i pozwala bezpiecznie je zwolnić. Przeglądarki ograniczają, ile pamięci może zużyć jedna witryna, więc zrozumienie, co zajmuje miejsce, utrzymuje Haven w dobrej formie.

Duża liczba u góry sumuje wszystko, co Haven trzyma w tej chwili w tej przeglądarce: każdą lokalną bazę danych, każdą pamięć podręczną, każdy plik hostowanej aplikacji. Przycisk Odśwież przelicza to po dużych operacjach, takich jak synchronizacja, usunięcie albo wyczyszczenie pamięci podręcznej. Liczby nie odświeżają się automatycznie, bo mierzenie dużych magazynów może być powolne. Obok przycisk Odzyskaj nieukończone przesyłania zwalnia zaszyfrowane fragmenty pozostałe po przesyłaniach załączników, które nigdy się nie zakończyły; załączniki, które trafiły do historii dokumentu, nie są nigdy ruszane.

Pod sumą sekcja z podziałem na tenanty pokazuje po jednym bloku na tenanta. Nagłówek każdego tenanta ma jego łączny rozmiar plus przycisk Wyczyść pamięć podręczną, który usuwa tylko części dające się odbudować — pamięci podręczne i indeksy, które Haven wypełni ponownie przy następnym użyciu tenanta. Wyczyść pamięć podręczną nie usuwa dokumentów ani załączników.

Wewnątrz każdego tenanta każdy wiersz to jedna lokalna baza danych. Dokumenty to zaszyfrowana treść dokumentów, Załączniki to zaszyfrowane fragmenty załączników, a Łącznie to suma obu. Usuń wymazuje lokalną zawartość tej bazy danych wyłącznie w tej przeglądarce — kopia na serwerze nie jest dotykana. Chronionej bazy danych katalogu nie da się usunąć, bo Haven jej potrzebuje do działania. Przed usunięciem otwórz bazę danych i uruchom synchronizację; jeśli są niezsynchronizowane zmiany lokalne, usunięcie je traci. Wybieraj raczej Wyczyść pamięć podręczną, gdy chcesz tylko zwolnić miejsce, bo jest odwracalne.

Pod bazami danych każdego tenanta zobaczysz też jego pamięci podręczne: lokalną pamięć podręczną tenanta na ogólny stan per tenant, pamięć podręczną celu serwerowego dla każdego serwera MindooDB, z którym tenant rozmawia, pamięć podręczną widoku wirtualnego dla każdego zapisanego widoku oraz wpis Indeks pełnotekstowy (MiniSearch) dla każdej bazy danych z włączonym indeksowaniem pełnotekstowym. Każda pamięć podręczna pokazuje własny rozmiar, a pamięci podręczne widoków wirtualnych da się czyścić pojedynczo, jeśli jeden konkretny widok zbyt się rozrósł.

Blok Globalne pamięci podręczne na dole obejmuje współdzielone pamięci podręczne Haven, które leżą poza jakimkolwiek jednym tenantem, takie jak pamięci podręczne service workera dla hostowanych aplikacji. Mają ten sam odczyt rozmiaru co pamięci podręczne na poziomie tenanta.

## Instalacja Haven na telefonie

Haven jest progresywną aplikacją webową, co oznacza, że każda nowoczesna przeglądarka mobilna może go zainstalować, jakby był aplikacją natywną. Po instalacji otwiera się w trybie samodzielnym, bez paska adresu i paska kart przeglądarki, co jest czystsze i daje więcej miejsca na ekranie.

Na iPhonie i iPadzie otwórz Haven w Safari i dotknij przycisku udostępniania — ikony wyglądającej jak kwadrat ze strzałką skierowaną w górę. Przewiń arkusz udostępniania, aż zobaczysz „Dodaj do ekranu początkowego”, i dotknij go. iOS ma już ikonę i nazwę Haven, więc wypełni je za Ciebie. Potwierdź nazwę i dotknij Dodaj, a ikona Haven pojawi się na Twoim ekranie głównym.

iOS ma miły dodatek: możesz dodać Haven do ekranu głównego więcej niż raz. Każda zainstalowana kopia dostaje na urządzeniu własny prywatny magazyn, więc dane w jednej kopii są całkowicie oddzielone od pozostałych. To świetny sposób na trzymanie różnych światów osobno na tym samym iPhonie — jedna kopia na prywatne notatki, jedna na pracę, jedna na demonstracje — bez ciągłego logowania i wylogowywania. Przed drugim dotknięciem Dodaj zmień proponowaną nazwę (na przykład na Haven - Praca), żeby ikony na ekranie głównym łatwo było odróżnić. Każda kopia startuje pusta i potrzebuje własnej tożsamości użytkownika, tenantów i zsynchronizowanych baz danych. Zwróć uwagę, że zaszyfrowane kopie zapasowe też są per kopia: przywracaj kopię zapasową wewnątrz tej samej kopii, z której ją wyeksportowałeś, bo inaczej nadpiszesz inne środowisko.

Na Androidzie otwórz Haven w nowoczesnej przeglądarce, takiej jak Chrome albo Edge. Jeśli Haven pokaże przycisk instalacji, przyjmij go, a przeglądarka doda Haven do ekranu głównego i do szuflady aplikacji w jednym kroku. Jeśli nie ma żadnej propozycji, otwórz menu przeglądarki (zwykle trzy kropki w narożniku) i poszukaj pozycji instalacji aplikacji albo dodania do ekranu głównego — różne przeglądarki formułują to różnie, ale wynik jest ten sam. Potwierdź propozycję przeglądarki i Haven pojawi się na ekranie głównym jako zwykła ikona aplikacji Android.

Po instalacji zawsze uruchamiaj Haven z ikony na ekranie głównym, gdy jesteś na telefonie — jest to wyraźnie przyjemniejsze doświadczenie niż karta przeglądarki.

## Model bezpieczeństwa w skrócie

Jeśli chcesz komuś wyjaśnić Haven w jedną minutę, to jest to podsumowanie.

Każdy użytkownik ma tożsamość kryptograficzną złożoną z klucza podpisującego Ed25519 i klucza szyfrującego RSA-OAEP. Oba klucze prywatne są zaszyfrowane sekretem, który masz tylko Ty, przechowywane lokalnie w przeglądarce i nigdy nie przesyłane. Ta tożsamość jest tym, co odblokowuje tenanty i podpisuje Twoje zmiany.

Sekretem może być hasło albo klucz dostępu i oba kończą w tym samym miejscu. Haven daje każdej tożsamości jeden wewnętrzny losowy klucz, który szyfruje klucze prywatne, a potem opakowuje ten klucz raz na każdą metodę odblokowania: opakowanie hasłem wyprowadzone przez PBKDF2 i opakowanie kluczem dostępu wyprowadzone z rozszerzenia PRF WebAuthn. Dodanie albo usunięcie metody odblokowania tylko dodaje albo usuwa opakowanie, i dlatego możesz mieć obie naraz i dlatego żadna nigdy nie dowiaduje się sekretu drugiej. Ten sam mechanizm sprawia, że działa YubiKey: dla WebAuthn klucz bezpieczeństwa i wbudowany czujnik Face ID są tym samym rodzajem uwierzytelniacza, więc Haven nie wyklucza kluczy przenośnych — wybierz YubiKey, jeśli chcesz, żeby sekret odblokowania mieszkał na czymś, co możesz schować do szuflady, a nie na samym laptopie. Czego nie ma, to kopii w chmurze: nic nie jest deponowane u MindooDB, u Apple ani u dostawcy Twojej przeglądarki, a klucz dostępu nie jest synchronizowany do kopii zapasowej iCloud ani Google w formie, którą Haven mógłby odzyskać. To jest świadomy kompromis — żadnego serwera nie da się zmusić do odblokowania Twoich danych i żaden serwer nie pomoże Ci, jeśli stracisz każdy sekret, jaki miałeś. Twój plik zaszyfrowanej kopii zapasowej jest całą historią odzyskiwania i dlatego karta Kopia zapasowa nie jest opcjonalna.

Każdy tenant ma KeyBag — zaszyfrowany magazyn kluczy szyfrujących, otwierany przez tożsamość będącą jego właścicielem. Klucz domyślny jest udostępniony każdemu członkowi tenanta i szyfruje dokumenty, o ile nie wybrano bardziej szczegółowego klucza. Klucze nazwane dają precyzyjny dostęp mniejszej grupie na potrzeby szczególnie wrażliwych dokumentów. Wszystko to leży na Twoim urządzeniu; serwer nigdy nie widzi kluczy.

Każdy dokument jest CRDT Automerge przechowywanym w magazynie adresowanym treścią. Każda zmiana jest podpisana Twoim kluczem Ed25519 i zaszyfrowana algorytmem AES-256-GCM, jeszcze zanim opuści przeglądarkę. Serwer przechowuje i przekazuje szyfrogram i nigdy nie może przeczytać Twoich danych, nawet jeśli zostanie w pełni przejęty. Transport dodaje drugą warstwę szyfrowania RSA-OAEP per użytkownik, a TLS otula całość jako trzecia warstwa. Kontrola dostępu jest wymuszana szyfrowaniem, co oznacza, że jeśli nie masz klucza, dokument jest po prostu szyfrogramem — nie ma zaufanego serwera, którego można by poprosić o uprawnienie i podstępem je uzyskać.

Ponieważ każda zmiana jest podpisana i dołączona do łańcucha, historii nie da się przepisać po cichu. Eksplorator DAG w Haven jest bezpośrednim przedstawieniem tego łańcucha, a Automerge scala równoległe edycje deterministycznie, więc dwie osoby mogą pracować nad tym samym dokumentem bez okna konfliktu.

Aplikacje działające w Haven są owinięte piaskownicą przeglądarki na własnym originie. Hostowane aplikacje dostają jeszcze ostrzejszą piaskownicę z opaque origin. Aplikacja nie dosięga magazynu Haven, jego ciasteczek ani innych aplikacji; widzi wyłącznie zmapowane przez Ciebie bazy danych i przyznane uprawnienia. Każde wywołanie aplikacji — odczyt, zapis, załączniki, historia — płynie przez mostek SDK Haven, który sprawdza je wobec mapowania, zanim dotknie jakichkolwiek danych. Hostowane aplikacje nie mogą też dzwonić do internetu, o ile nie wymieniłeś adresu URL; domyślnie jest odmowa. Pełny model, pozostałe ryzyka i różnicę wobec aplikacji przechowywanych w bazie danych MindooDB opisuje [hosted-app isolation](hosted-app-isolation.md).

To, w jedną minutę, jest powodem, dla którego Haven jest prywatny z założenia, a nie z regulaminu.

## Słownik

To są terminy, których Haven używa na swoich ekranach i w szufladzie pomocy. Są wymienione mniej więcej w kolejności, w jakiej najprawdopodobniej je napotkasz, a nie ściśle alfabetycznie, bo większość z nich opiera się na poprzednich.

Tożsamość użytkownika — Twoje konto w Haven. Tworzona lokalnie, chroniona kluczem dostępu albo hasłem, i to ona odblokowuje tenanty oraz podpisuje Twoje zmiany. Karta w Ustawieniach nazywa się Identyfikatory użytkowników.

Klucz dostępu — metoda odblokowania oparta na uwierzytelniaczu Twojego urządzenia: Face ID, Touch ID, Windows Hello albo klucz bezpieczeństwa, taki jak YubiKey. Haven wyprowadza z niej lokalnie klucz, który otwiera Twoje klucze prywatne, więc sekret nigdy nie opuszcza urządzenia i nigdy nie jest wysyłany na serwer.

Fraza hasłowa — kilka losowych słów używanych zamiast hasła. Haven oferuje wygenerowaną sześciowyrazową frazę hasłową dla tożsamości administratora, bo jest zarazem mocniejsza niż typowe wpisywane hasło i łatwa do zapisania; wpisanie własnego hasła zamiast tego pozostaje dostępne.

Tenant — prywatny obszar roboczy Twojego zespołu w MindooDB. Grupuje razem użytkowników, klucze szyfrujące i bazy danych, żeby zespół mógł bezpiecznie dzielić dane.

Etykieta tenanta — czytelna dla człowieka nazwa tenanta. Haven generuje identyfikator tenanta sam i nigdy się on nie zmienia; etykieta jest częścią, którą wybierasz Ty, a administrator może ją zmienić, kiedy przestanie pasować.

Administrator tenanta — uprzywilejowana tożsamość wewnątrz tenanta. Może rejestrować i odwoływać innych użytkowników oraz zmieniać ustawienia całego tenanta.

Użytkownik aplikacji — zwykła tożsamość użytkownika wewnątrz tenanta. Wykonuje codzienną pracę na dokumentach, ale nie może rejestrować ani odwoływać innych użytkowników.

Administrator systemu — tożsamość na poziomie serwera, używana do zarządzania samym serwerem MindooDB: podłączania do niego Haven, ufania innym serwerom i zakładania nowych tenantów.

KeyBag — lokalny, zaszyfrowany magazyn kluczy, który trzyma klucze szyfrujące potrzebne tenantowi, otwierany przez tożsamość będącą jego właścicielem. Każdy użytkownik trzyma własny w tej przeglądarce.

Klucz domyślny — klucz szyfrujący udostępniony każdemu członkowi tenanta. Jeśli dokument nie wskazuje klucza nazwanego, jest szyfrowany kluczem domyślnym.

Klucz nazwany — dodatkowy klucz szyfrujący udostępniony wyłącznie wybranym użytkownikom. Przydatny do wrażliwych dokumentów, które nie powinny być widoczne dla całego tenanta.

Klucz użytkownika — para kluczy szyfrujących, która należy do osoby, a nie do urządzenia czy tenanta. Jej połowa publiczna jest opublikowana w tenancie, żeby inni mogli szyfrować dla Ciebie (właśnie tak dociera do Ciebie klucz domyślny); jej połowa prywatna żyje wyłącznie na urządzeniach, które zatwierdziłeś. Jeden klucz użytkownika na osobę, jedna zapakowana kopia na zatwierdzone urządzenie.

Zatwierdzenie urządzenia — krok, który pozwala nowej przeglądarce albo nowemu telefonowi czytać dokumenty tenanta. Już zatwierdzone urządzenie zapisuje kopię Twojego klucza użytkownika dla nowicjusza; dopóki to nie nastąpi, nowe urządzenie może synchronizować szyfrogram, ale nie umie go otworzyć. Zatwierdzenie musi zawsze przyjść z urządzenia, które samo jest już zatwierdzone.

Wydruk awaryjny tenanta — przeznaczony do druku arkusz nadmiarowych kodów QR dla jednego tenanta, zawierający tożsamości, klucze z KeyBaga oraz konfigurację serwera i synchronizacji, ale bez dokumentów. Tworzony na karcie Kopia zapasowa, przywracany na karcie Przywracanie, i jedyna droga powrotna, gdy zniknęło każde zatwierdzone urządzenie.

Podpisana zmiana — każda edycja dokumentu jest podpisana kluczem prywatnym autora. Dowodzi to, kto dokonał zmiany, i uniemożliwia późniejsze fałszowanie historii.

Lokalna replika — zsynchronizowana kopia baz danych tenanta trzymana lokalnie w przeglądarce. Szybka, działa offline i jest zalecanym sposobem przeglądania i edycji.

Źródło żywe — tryb źródła, który pobiera świeże dane z serwera MindooDB przed użyciem ich. Wolniejszy niż lokalna replika, ale przydatny, gdy potrzebujesz najnowszego stanu.

Strumień zmian — strumień, którym serwer ogłasza nowe zapisy klientom, którzy go nasłuchują. Haven trzyma jeden otwarty na każdy serwer i tenanta, z którego pobiera, i to właśnie sprawia, że przychodząca praca dociera sama. Zawsze włączony; bez własnego ustawienia.

Synchronizacja peer-to-peer — bezpośrednia synchronizacja między dwoma urządzeniami tego samego tenanta, bez serwera na drodze. Działa na sieci Iroh. Urządzenie odbierające potrzebuje włączonej opcji Akceptuj przychodzącą synchronizację urządzeń oraz otwartej i odblokowanej karty.

Punkt końcowy — adres, pod który dzwoni się do urządzenia przy synchronizacji peer-to-peer. Haven generuje jeden na urządzenie i publikuje go w katalogu użytkowników tenanta, żeby urządzenia mogły się nadal znajdować, gdy serwer jest nieosiągalny.

Iroh — sieć, której Haven używa, gdy nie ma osiągalnego adresu, pod który można się połączyć. Niesie synchronizację peer-to-peer między dwoma urządzeniami i może też nieść zwykłą synchronizację klient-serwer do serwera MindooDB, który do niej przystąpił — takiego za routerem z NAT, powiedzmy, bez przekierowanego portu i bez certyfikatu. Oba końce spotykają się przez relay, który widzi, że rozmawiają, ale nie to, co mówią.

Szybki skan — wbudowany skaner dokumentów Haven. Znajduje krawędzie strony, koryguje perspektywę i bierze do jednego skanu tyle stron, ile potrzebujesz. Działa w całości w karcie przeglądarki, także offline. Wydaje wynik jako plik — wielostronicowy PDF albo PNG lub JPEG dla jednej strony — przez pobranie albo systemowy arkusz udostępniania; dołączenie skanu do dokumentu robi się z Przeglądarki baz danych albo przez aplikację korzystającą z App SDK.

IndexedDB — wbudowana baza danych przeglądarki. Haven trzyma w IndexedDB niemal wszystko, żeby móc działać offline.

Bajty ładunku — przybliżony pomiar tego, ile prawdziwej treści Haven trzyma w tej przeglądarce. Nie obejmuje narzutu, który dokłada sama przeglądarka.

Lokalna pamięć podręczna tenanta — pamięć podręczna przeglądarki per tenant, która pomaga Haven szybciej wracać do pracy, wznawiać synchronizację i ponownie używać lokalnych danych zapytań. Można ją wyczyścić i odbudowuje się automatycznie.

Pamięć podręczna celu serwerowego — pamięć podręczna zawężona do jednego tenanta i jednego serwera. Przyspiesza synchronizację żywą z tym serwerem i można ją bezpiecznie wyczyścić.

Pamięć podręczna widoku wirtualnego — przechowuje zmaterializowane wyniki widoku wirtualnego plus jego wznawialny stan indeksowania, żeby widok otwierał się szybko. Wyczyszczenie jej powoduje odbudowę widoku przy następnym otwarciu.

Chroniona baza danych — baza danych, której Haven potrzebuje do działania (na przykład katalog tenanta). Nie da się jej usunąć z panelu magazynu.

Start — nieruchoma pierwsza karta obszaru roboczego. Nosi sześć kafelków skrótów Haven i po jednym kafelku na zainstalowaną aplikację. Nie da się jej przestawiać; Twoje własne kafelki idą na strony obok niej.

Kafelek — przeciągalna karta o zmiennym rozmiarze na siatce obszaru roboczego. Każdy kafelek trzyma bazę danych, aplikację, notatkę, osadzoną stronę internetową, wideo albo diagram. Nazywany też Chicklet.

Strona — karta obszaru roboczego, która zawiera własną siatkę kafelków. Używaj wielu stron jak ekranów głównych w smartfonie.

Grupa — wizualny pojemnik, który skupia powiązane kafelki pod wspólnym, oznaczonym kolorem nagłówkiem. Przeciągnij jeden kafelek na drugi, aby utworzyć grupę.

Szuflada aplikacji — panel za uchwytem ze strzałką u góry obszaru treści. Wymienia otwarte ekrany Haven i aktualnie działające aplikacje, z drogą powrotną do obszaru roboczego nad jednym i drugim. `Cmd+Shift+Space` ją otwiera, a `Cmd+Shift+Enter` wraca do obszaru roboczego; w systemach Windows i Linux naciskaj `Ctrl` zamiast `Cmd`.

Baza danych — zbiór powiązanych dokumentów wewnątrz tenanta. Tenant może mieć wiele baz danych (na przykład kontakty, faktury, notatki).

Baza danych katalogu — specjalna chroniona baza danych w każdym tenancie, która przechowuje rejestracje użytkowników i ustawienia całego tenanta.

Dokument — pojedyncza pozycja danych wewnątrz bazy danych. Szyfrowana na tym urządzeniu przed synchronizacją, więc serwer widzi wyłącznie szyfrogram.

Rewizja — wersja dokumentu z konkretnego punktu w czasie. Każda zmiana tworzy nową rewizję; starsze rewizje zostają czytelne, dopóki historia jest zachowywana.

Załącznik — plik dołączony do dokumentu. Przechowywany w zaszyfrowanych fragmentach i strumieniowany na żądanie.

Automerge — silnik scalania bez konfliktów, którego MindooDB używa pod spodem. Dwie osoby mogą edytować ten sam dokument w tym samym czasie, a Automerge scali ich zmiany automatycznie.

Eksplorator DAG — widok grafowy każdej zmiany, jaka kiedykolwiek została zastosowana do dokumentu, w tym tego, jak równoległe edycje zostały scalone razem.

Widok wirtualny — widok drzewa w stylu arkusza kalkulacyjnego nad Twoimi dokumentami, który je filtruje, kategoryzuje, sortuje i podsumowuje. Może czerpać z jednej bazy danych, z kilku baz danych, a nawet z kilku tenantów.

Pochodzenie — identyfikator, który oznacza, z której bazy danych (albo z którego tenanta) przyszedł wiersz w widoku wirtualnym. Przydatny, gdy jeden widok łączy kilka źródeł.

Zmaterializowany indeks — wstępnie obliczone wyniki widoku przechowywane w tej przeglądarce, żeby widok wirtualny można było otworzyć natychmiast.

Haven App Store — katalog gotowych aplikacji MindooDB, otwierany ze Startu. Instalacja wpisu pisze za Ciebie jego rejestrację i kładzie aplikację na Starcie.

App Builder — aplikacja w store, która buduje inne aplikacje. Opisujesz, czego potrzebujesz; ona tworzy repozytorium, publikuje aplikację, każe agentowi AI ją napisać i przekazuje ją Haven do instalacji. Wynikiem jest zwykła aplikacja MindooDB z kodem źródłowym na Twoim własnym koncie GitHub.

Rejestracja aplikacji — zapisana po stronie Haven definicja aplikacji MindooDB: skąd ją uruchamiać, jak ją uruchamiać i które bazy danych lub widoki wolno jej zobaczyć.

Hostowany pakiet — spakowany zestaw zasobów webowych zaimportowany do Haven, żeby mógł wydawać aplikację lokalnie, także offline.

Zewnętrzny adres URL — adres internetowy aplikacji hostowanej poza Haven, na przykład lokalnego serwera developerskiego albo wdrożonej aplikacji webowej.

App connector (mostek) — bezpieczny kanał między aplikacją MindooDB a Haven. Aplikacje nigdy nie rozmawiają z Twoimi danymi bezpośrednio; każdy odczyt i zapis idzie przez ten konektor, żeby Haven mógł wymusić przyznane przez Ciebie uprawnienia.

Kontekst uruchomienia — początkowe informacje, które aplikacja dostaje od Haven przy starcie: motyw, viewport, bieżący użytkownik, parametry uruchomienia i przyznane jej bazy danych.

Tryb uruchamiania — sposób, w jaki zarejestrowana aplikacja jest startowana: osadzona w oknie Haven albo otwarta we własnej karcie przeglądarki. Różny od trybu wyświetlania kafelka, który decyduje, czy kafelek jest uruchamiaczem klikanym dwukrotnie, czy sam uruchamia aplikację w karcie.

Piaskownica — izolacja wymuszana przez przeglądarkę, która owija każdą aplikację. Aplikacja nie dosięga magazynu Haven, jego ciasteczek ani innych aplikacji, o ile wprost nie udostępnisz jej danych.

Zestaw motywu — nazwana paleta kolorów dla Haven (na przykład Mindoo albo Aura). Przełączenie zestawu zmienia kolory akcentu w całej aplikacji.

Tryb jasny / ciemny — czy Haven używa jasnego czy ciemnego tła. Wybór jest pamiętany wyłącznie w tej przeglądarce.

Tryb samodzielny — tryb wyświetlania, w którym Haven startuje bez zwykłych elementów przeglądarki, jak dedykowana aplikacja. Dostępny po dodaniu Haven do ekranu głównego telefonu.

Dodaj do ekranu początkowego — akcja przeglądarki, która zapisuje Haven jako uruchamialną ikonę na ekranie głównym telefonu albo tabletu.

Propozycja instalacji — systemowy arkusz przeglądarki, który potwierdza dodanie progresywnej aplikacji webowej, takiej jak Haven, do urządzenia.

Zaszyfrowana kopia zapasowa — jeden plik zawierający wszystko, co Haven trzyma w tej przeglądarce, zaszyfrowany wybranym przez Ciebie hasłem. Bez tego hasła plik jest nieczytelny.

Hasło kopii zapasowej — jedno hasło używane do zaszyfrowania i późniejszego odszyfrowania pliku kopii zapasowej, niezależnie od tego, czym odblokowują się tożsamości w środku. Otwiera też każdą tożsamość chronioną wyłącznie kluczem dostępu przywróconą z tego pliku na nowym urządzeniu. Haven nigdy go nie przechowuje; jeśli je zgubisz, kopii zapasowej nie da się przywrócić.

Podgląd przywracania — bezpieczny krok, który odszyfrowuje plik kopii zapasowej tylko na tyle, by pokazać Ci, co zawiera, przed dotknięciem jakichkolwiek danych lokalnych.

Ostrzeżenie przywracania — uwaga pokazywana w trakcie podglądu, gdy kopia zapasowa zawiera bazy danych, które przy przywracaniu będą musiały być odbudowane pusto albo pominięte.

Przywracanie ustawień fabrycznych — wymazuje z tej przeglądarki wszystkie dane Haven, w tym tożsamości, tenanty, aplikacje, hostowane aplikacje, widoki wirtualne i zsynchronizowane dane MindooDB. Nie da się tego cofnąć.

## Edycje, cennik i otwarta platforma

Haven jest dostępny w dwóch edycjach, a ta, która wystarczy większości ludzi na zawsze, jest darmowa.

Haven Community to darmowa edycja Haven, w wersji beta, dostępna już dziś na [haven.mindoodb.com](https://haven.mindoodb.com). Jest to ten sam klient, który zespół MindooDB rozwija, wdraża i używa u siebie. „Beta” oznacza tu, że da się w nim pracować na serio, a nie że jest makietą — aktywnie się rozwija, informacja zwrotna wchodzi wprost do planu rozwoju, a formalnej umowy SLA jeszcze nie ma. Jeśli potrzebujesz gwarantowanych czasów reakcji, do tego służy komercyjny poziom wsparcia.

Haven Community działa w trzech topologiach wdrożenia. Wyłącznie lokalnej, gdzie wszystko leży w Twojej przeglądarce i nie ma żadnego serwera — idealnej do prywatnych notatek i demonstracji offline; w tym trybie karta Ustawienia → Kopia zapasowa pełni jednocześnie rolę mechanizmu przenoszenia, bo zaszyfrowany plik `.mdbhaven-backup` zawiera Twoje tożsamości użytkowników, ustawienia i bazy danych MindooDB, więc możesz przenieść kompletny, wyłącznie lokalny Haven z jednej przeglądarki do drugiej przez eksport i przywrócenie. Podłączonej do hostowanego serwera demo Mindoo, która pozwala opublikować lokalnego tenanta i przetestować prawdziwą współpracę wielu użytkowników; dane serwera demo są okresowo wymazywane, więc służy on do ewaluacji, a nie do produkcji. Oraz samodzielnie hostowanej, gdzie kierujesz Haven na serwer MindooDB, który prowadzisz sam, z pełną instrukcją konfiguracji w [`README-server.md`](https://github.com/klehmann/MindooDB/blob/main/README-server.md) w repozytorium MindooDB. Wybór jest Twój i możesz przechodzić między topologiami w dowolnym momencie.

Haven Community jest też kompletną platformą do tworzenia własnych aplikacji. Możesz budować aplikacje MindooDB ręcznie za pomocą App SDK albo pozwolić agentowi AI wygenerować je ze strukturalnego pliku `llms-full.txt` na mindoodb.com plus publicznych repozytoriów aplikacji referencyjnych. Haven App Store przychodzi z katalogiem gotowych aplikacji, które zainstalujesz jednym kliknięciem — zarówno żeby ich używać, jak i żeby zobaczyć, jak wygląda dopracowana aplikacja MindooDB. Mindoo Vega renderuje to samo drzewo węzłów jako mapę myśli, tablicę Kanban, diagram Gantta albo arkusz kalkulacyjny, z polami zadań, załącznikami, podróżą w czasie przez historię dokumentu i wyszukiwaniem pełnotekstowym — przydatne przy planowaniu projektów, gdzie te same dane potrzebują raz widoku z lotu ptaka, a chwilę później układu tor po torze albo data po dacie. Mindoo TodoManager zamienia czterokwadrantową metodę Coveya (ważne/nieważne, pilne/niepilne) w wizualny przebieg pracy nad zadaniami, który pomaga skupiać się na tym, co liczy się najbardziej. [Mindoo Weather](https://github.com/klehmann/mindoodb-app-weather) to kafelek w stylu Pogody z iOS, który pokazuje prognozę na 10 dni plus jakość powietrza dla jednej lub wielu lokalizacji skonfigurowanych parametrem uruchomienia — dostosowuje się na żywo do rozmiaru kafelka, który zgłasza Haven (wąski: jedna przesuwalna karta z kropkami; szerszy: od dwóch do czterech naraz) i pobiera wszystkie dane z bezkluczowych API Open-Meteo, więc pełni też rolę wzorca dla strony UX w SDK. Katalog nosi także App Builder, który pisze, publikuje i instaluje nową aplikację z wpisanego przez Ciebie opisu, oraz aplikację przykładową SDK dla programistów, którzy chcą żywej referencji każdej funkcji SDK. Wszystkie są darmowe w użyciu.

Leżąca pod tym platforma MindooDB jest otwartoźródłowa na licencji Apache 2.0. Ma to znaczenie wykraczające poza cenę: nie ma uzależnienia od dostawcy w warstwie danych. Model danych, magazyn adresowany treścią i protokół synchronizacji są udokumentowane i da się je zaimplementować od nowa, co oznacza, że zespół może w dowolnym momencie zabrać swoje zaszyfrowane dane ze sobą — a na tej samej platformie da się nawet zbudować całkowicie alternatywne klienty, jeśli Haven nie jest właściwym wyborem do konkretnego zastosowania. Haven jest klientem oficjalnym; nie jest jedynym możliwym.

Haven Enterprise to komercyjna edycja, którą Mindoo GmbH wciąż rozbudowuje, zbudowana na dokładnie tym samym rdzeniu MindooDB. Jej funkcje odblokowuje klucz licencyjny Enterprise, a pojawiają się pojedynczo, nie wszystkie naraz. Pierwsza, z której możesz korzystać już dziś, to przenoszenie obszaru roboczego między urządzeniami i profilami przeglądarki: ustawienie Przenoszony obszar roboczy w Ustawienia → Ogólne to dokładnie ta funkcja i dlatego przełącznik pozostaje wyłączony, dopóki nie zaimportujesz licencji. Wciąż powstają własny branding (logo, kolory, nazwa produktu i domena, żeby Haven czuł się jak Twój własny produkt), zarządzany interfejs użytkownika z domyślnymi ustawieniami specyficznymi dla organizacji, zarządzane szablony obszaru roboczego wypychane do użytkowników, żeby lądowali w skonfigurowanym środowisku, wewnętrzny app store do kurowania własnych i zewnętrznych aplikacji MindooDB, automatyczne kopie zapasowe danych w przeglądarce według harmonogramu, pełnoprawne narzędzia kopii zapasowej dla danych tenanta przechowywanych na Twoim serwerze oraz edycja typowych załączników Office i tekstowych na miejscu, bez pobierania ich. Lista rośnie dalej wraz z dojrzewaniem klienta Enterprise — informacja zwrotna od klientów kształtuje plan rozwoju bezpośrednio.

Wybór Haven Enterprise nigdy nie zabiera Cię z otwartej platformy. Rdzeń MindooDB i PWA Haven zostają darmowe i otwarte; Enterprise jest osobnym, komercyjnym klientem położonym na wierzchu. Możesz zacząć na Community, przejść później na Enterprise, a w każdym z tych kierunków Twoje dane i Twój serwer zostają dokładnie tam, gdzie były.

Aktualne szczegóły, cennik i listę wczesnego dostępu do Haven Enterprise znajdziesz na stronie cennika Haven pod adresem [mindoodb.com/pl/haven/pricing](https://mindoodb.com/pl/haven/pricing/).

## Gdzie iść dalej

Haven jest aktywnie rozwijanym produktem i jest też publiczną twarzą MindooDB. Kilka zasobów warto dodać do zakładek.

Najprostszym sposobem, by naprawdę wypróbować Haven, jest otwarcie [haven.mindoodb.com](https://haven.mindoodb.com) w nowoczesnej przeglądarce — to jest żywy klient Community.

Strony produktowe pod adresem [mindoodb.com](https://mindoodb.com/pl/) wchodzą głębiej w pozycjonowanie i model bezpieczeństwa i pokrywają te części historii, których podręcznik pokryć nie może — zrzuty ekranu, plan rozwoju i szerszą platformę MindooDB.

[MindooDB App SDK na GitHubie](https://github.com/klehmann/mindoodb-app-sdk) jest biblioteką TypeScript do budowania aplikacji działających w Haven. Dwa towarzyszące projekty otwartoźródłowe pokazują, jak wyglądają zbudowane na nim aplikacje o jakości produkcyjnej: [projekt przykładowy](https://github.com/klehmann/mindoodb-app-example) jest referencyjną aplikacją Vue 3, która demonstruje każdą funkcję SDK na trzech kartach (bazy danych, widoki, zdarzenia) — jej żywe demo leży pod adresem [app-example.mindoodb.com](https://app-example.mindoodb.com) i da się je zarejestrować w Haven jako zewnętrzny adres URL na kilka minut praktycznej eksploracji; a [`mindoodb-app-weather`](https://github.com/klehmann/mindoodb-app-weather) koncentruje się na stronie UX w SDK, pokazując parametry uruchomienia, zdarzenia viewportu i responsywne osadzanie na przykładzie dopracowanego kafelka w stylu Pogody z iOS.

W samym Haven pamiętaj o przycisku Pomoc w górnym pasku. Każdy ekran ma własny artykuł pomocy, napisany w tym samym przyjaznym stylu co ten podręcznik, oraz krótki przewodnik reflektorowy, który podświetla ważne elementy. Gdy masz wątpliwości na ekranie, którego wcześniej nie używałeś, otwórz go najpierw — zwykle jest to szybsze niż czytanie o nim gdzie indziej.

To jest Haven. Local-first, szyfrowany end-to-end, hostujący aplikacje obszar roboczy w karcie przeglądarki. Prywatny z założenia, spokojny domyślnie i gotowy niezależnie od tego, czy jesteś online, czy nie.
