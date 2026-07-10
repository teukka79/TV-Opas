/**
 * Apufunktio: Muunnetaan XMLTV-aikaleima JS Date -objektiksi.
 */
function parseeraaXmlAika(aikaStr) {
    if (!aikaStr) return null;
    const v = aikaStr.substring(0, 4);
    const kk = aikaStr.substring(4, 6) - 1;
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
        // 1. Haetaan EPG (XML) ja logolistaus (TXT) rinnakkain
        const [epgRes, logotRes] = await Promise.all([
            fetch('opas.xml'),      // XML-datasi polku
            fetch('logot_suomi.txt')    // Tekstitiedostosi polku projektin juuressa
        ]);

        const xmlTeksti = await epgRes.text();
        const logotTeksti = await logotRes.text();

        // 2. Parsitaan Markdown-muotoinen logolistaus objektiksi ([tunnus]: url)
        const logoKartta = {};
        logotTeksti.split('\n').forEach(rivi => {
            const trimmattu = rivi.trim();
            if (trimmattu.startsWith('[') && trimmattu.includes(']:')) {
                // Katkaistaan rivi vain ensimmäisen ']:' kohdalta, ettei URL:n oma protokolla hajoa
                const jakoIndeksi = trimmattu.indexOf(']:');
                
                // Puhdistetaan tunnus (esim. "[yle-tv1" -> "yle-tv1")
                const tunnus = trimmattu.substring(1, jakoIndeksi).toLowerCase().trim();
                // Otetaan URL talteen katkaisukohdan jälkeen
                const url = trimmattu.substring(jakoIndeksi + 2).trim();
                
                if (tunnus && url) {
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
        let kanavaIdt = JSON.parse(localStorage.getItem('kanavaJarjestys')) || Object.keys(ohjelmaIndeksi);

        // 6. Piirretään opas tyhjentämällä ensin vanha kontti
        const opasKontti = document.getElementById('opas-kontti');
        if (opasKontti) {
            opasKontti.innerHTML = '';

            kanavaIdt.forEach(xmltvId => {
                const kanavanOhjelmat = ohjelmaIndeksi[xmltvId] || [];
                
                // Etsitään parhaillaan tuleva ohjelma
                const nykyinenOhjelma = kanavanOhjelmat.find(o => o.start <= nyt && o.stop >= nyt);
                
                const ohjelmaTeksti = nykyinenOhjelma 
                    ? `${nykyinenOhjelma.start.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})} ${nykyinenOhjelma.title}`
                    : 'Ei ohjelmatiedon tietoja';

                // Mäppäys: Muunnetaan XMLTV-id vastaamaan TXT-tiedoston tunnusta (esim. "Yle TV1.fi" -> "yle-tv1")
                const logoHakuAvain = xmltvId.toLowerCase().replace('.fi', '').replace(/\s+/g, '-').trim();
                const suoraLogoUrl = logoKartta[logoHakuAvain] || '';

                // Luodaan kanavakortti HTML-rakenteena
                const kortti = document.createElement('div');
                kortti.className = 'kanava-kortti';
                kortti.setAttribute('data-id', xmltvId);
                
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

// Käynnistetään haku kun sivu on ladattu
document.addEventListener('DOMContentLoaded', paivitaTVOpas);
