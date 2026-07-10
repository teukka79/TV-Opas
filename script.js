/**
 * Apufunktio: Muunnetaan XMLTV-aikaleima (esim. "20260710183000 +0300") JS Date -objektiksi.
 */
function parseeraaXmlAika(aikaStr) {
    if (!aikaStr) return null;
    // Poimitaan vuosi, kuukausi, päivä, tunnit, minuutit
    const v = aikaStr.substring(0, 4);
    const kk = aikaStr.substring(4, 6) - 1; // Kuukaudet alkavat nollasta JS:ssä
    const p = aikaStr.substring(6, 8);
    const t = aikaStr.substring(8, 10);
    const m = aikaStr.substring(10, 12);
    return new Date(v, kk, p, t, m);
}

/**
 * Pääfunktio TV-oppaan lataamiseen ja päivittämiseen.
 */
async function paivitaTVOpas() {
    try {
        // 1. Haetaan EPG (XML) ja Markdown-muotoinen logolistaus (TXT) rinnakkain
        const [epgRes, logotRes] = await Promise.all([
            fetch('epg_cache.xml'),      // Korvaa tähän oma cached XML-polkusi
            fetch('logot_suomi.txt')    // Antamasi tekstitiedosto projektin juuressa
        ]);

        const xmlTeksti = await epgRes.text();
        const logotTeksti = await logotRes.text();

        // 2. Parsitaan Markdown-muotoinen logolistaus objektiksi ([tunnus]: url)
        const logoKartta = {};
        logotTeksti.split('\n').forEach(rivi => {
            const trimmattu = rivi.trim();
            // Otetaan kiinni vain rivit, jotka alkavat [ ja sisältävät ]:http
            if (trimmattu.startsWith('[') && trimmattu.includes(']:http')) {
                const osat = trimmattu.split(']:');
                if (osat.length >= 2) {
                    // Puhdistetaan hakutunnus (esim. "[yle-tv1" -> "yle-tv1")
                    const tunnus = osat[0].replace('[', '').trim();
                    // Otetaan URL (erotetaan mahdolliset Markdown-otsikot tai välilyönnit lopusta)
                    const url = osat[1].split(' ')[0].trim();
                    
                    logoKartta[tunnus] = url;
                }
            }
        });

        // 3. Parsitaan XMLTV-data
        const parseri = new DOMParser();
        const xmlDoc = parseri.parseFromString(xmlTeksti, "text/xml");
        
        // 4. Luodaan ohjelmalistaus XML:stä indeksiin haun nopeuttamiseksi
        const ohjelmaIndeksi = {};
        const nyt = new Date();
        const ohjelmaElementit = xmlDoc.querySelectorAll('programme');
        
        ohjelmaElementit.forEach(prog => {
            const channelId = prog.getAttribute('channel');
            if (!ohjelmaIndeksi[channelId]) {
                ohjelmaIndeksi[channelId] = [];
            }
            
            ohjelmaIndeksi[channelId].push({
                title: prog.querySelector('title')?.textContent || 'Ei nimeä',
                start: parseeraaXmlAika(prog.getAttribute('start')),
                stop: parseeraaXmlAika(prog.getAttribute('stop'))
            });
        });

        // 5. Haetaan selaimeen tallennettu kustomoitu kanavajärjestys localStoragesta.
        // Jos sitä ei ole, käytetään XML-datasta löytyviä kanavatunnuksia pohjana.
        let kanavaIdt = JSON.parse(localStorage.getItem('kanavaJarjestys')) || Object.keys(ohjelmaIndeksi);

        // 6. Piirretään opas tyhjentämällä ensin vanha kontti
        const opasKontti = document.getElementById('opas-kontti');
        if (opasKontti) {
            opasKontti.innerHTML = '';

            kanavaIdt.forEach(xmltvId => {
                const kanavanOhjelmat = ohjelmaIndeksi[xmltvId] || [];
                
                // Etsitään parhaillaan tuleva ohjelma (alku <= nyt <= loppu)
                const nykyinenOhjelma = kanavanOhjelmat.find(o => o.start <= nyt && o.stop >= nyt);
                
                const ohjelmaTeksti = nykyinenOhjelma 
                    ? `${nykyinenOhjelma.start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} ${nykyinenOhjelma.title}`
                    : 'Ei ohjelmatiedon tietoja';

                // Mäppäys: Muunnetaan XMLTV-id sellaiseen muotoon, että se vastaa TXT-tiedoston tunnusta.
                // Esimerkiksi: jos XMLTV-id on "YleTV1.fi" tai "yle-tv1.fi", muutetaan se muotoon "yle-tv1"
                const logoHakuAvain = xmltvId.toLowerCase().replace('.fi', '').replace('.uk', '').trim();
                const suoraLogoUrl = logoKartta[logoHakuAvain] || '';

                // Luodaan kanavakortti HTML-rakenteena
                const kortti = document.createElement('div');
                kortti.className = 'kanava-kortti';
                kortti.setAttribute('data-id', xmltvId); // Hyödyllinen drag-and-dropia tai järjestelyä varten
                
                kortti.innerHTML = `
                    <div class="kanava-otsikko">
                        ${suoraLogoUrl ? `<img src="${suoraLogoUrl}" alt="${xmltvId}" class="kanava-logo" onerror="this.style.display='none';">` : ''}
                        <span class="kanava-nimi">${xmltvId}</span>
                    </div>
                    <div class="kanava-ohjelma">
                        <span class="nyt-tulee">${ohjelmaTeksti}</span>
                    </div>
                `;
                
                opasKontti.appendChild(kortti);
            });
        }

    } catch (virhe) {
        console.error("Virhe TV-oppaan päivityksessä:", virhe);
    }
}

// Käynnistetään haku heti kun sivun HTML on latautunut ladatuksi
document.addEventListener('DOMContentLoaded', paivitaTVOpas);
