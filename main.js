// Include Apify SDK. For more information, see https://sdk.apify.com/
const Apify = require('apify');

/**
 * Gets attribute as text from a ElementHandle.
 * @param {ElementHandle} element - The element to get attribute from.
 * @param {string} attr - Name of the attribute to get.
 */
const getAttribute = async (element, attr) => {
    try {
        const prop = await element.getProperty(attr);
        return (await prop.jsonValue()).trim();
    } catch (e) { return null; }
};

// Checking if passed value is an object
const isObject = (val) => typeof val === 'object' && val !== null && !Array.isArray(val);

// Company page data extraction
const extractData = () => {
    // Název firmy
    const companyName = $('.detailPrimaryTitle').text().trim();

    // Adresa
    const address = $('.detailAddress').contents().get(0).nodeValue.trim();

    // Popis adresy (poznámka)
    const addressDescription = $('.detailAddressDescription').text().trim();

    // Webová stránka
    const websites = $('.detailWebUrl').toArray().map(e => e.href.trim());

    // Hodnocení
    const ratingElement = $('mapy-review-badge-composed-new');
    const rating = ratingElement.attr('rating') ? parseFloat(ratingElement.attr('rating')) : null;
    const reviews = ratingElement.attr('reviews') ? parseInt(ratingElement.attr('reviews')) : null;

    // Telefonní čísla
    const phones = $('.detailPhone span').toArray().map(e => e.textContent.trim());

    // E-maily
    const emails = $('.detailEmail a').toArray().map(e => e.textContent.trim());

    // IČO (Business ID)
    const businessId = $('.detailBusinessInfo').first().text().trim();

    // Sociální sítě
    const socialNetworks = $('.detailSocialNetworks a').toArray().map(e => ({
        platform: e.title.trim(),
        url: e.href.trim(),
    }));

    // Vlastní URL pro kontakt (pokud existuje)
    const contactLink = $('.detailDirection.custom a').attr('href') || null;

    // Popis firmy
    const companyDescription = $('.detailDescription p').text().trim();

    // Další služby
    const additionalServices = $('.detailDescription span[data-dot="filters"]').text().trim();

    // Návratový objekt
    return {
        companyName,
        address,
        addressDescription,
        website: websites[0] || null,
        rating,
        reviews,
        phones,
        emails,
        businessId,
        socialNetworks,
        contactLink,
        companyDescription,
        additionalServices,
    };
};


Apify.main(async () => {
    // Get input of the actor.
    const input = await Apify.getInput();

    // Open default dataset
    const dataset = await Apify.openDataset();
    let itemCount = (await dataset.getInfo()).cleanItemCount;

    // Parse extendOutpusFunction
    let extendOutputFunction;
    try {
        extendOutputFunction = eval(input.extendOutputFunction);
    } catch (e) {
        throw new Error(`extendOutputFunction is not a valid JavaScript! Error: ${e}`)
    }
    if (typeof extendOutputFunction !== "function") {
        throw new Error(`extendOutputFunction is not a function! Please fix it or use just default output!`)
    }

    // Open a request queue and request list
    let hasUrls = false;
    let requestList = null;
    const requestQueue = await Apify.openRequestQueue();
    if(input.startURLs){
        console.log('Enqueuing startUrls...');
        requestList = new Apify.RequestList({ sources: input.startURLs });
        await requestList.initialize(); 
        hasUrls = true;
    }
    if(input.search && input.search.length > 0){
        console.log('Enqueuing query search...');
        const query = input.search.replace(/\s/g, '+');
        await requestQueue.addRequest({ url: 'https://www.firmy.cz/?q=' + query });
        hasUrls = true;
    }
    if(!hasUrls){
        console.log('No search or startUrls provided, scraping the whole site...');
        await requestQueue.addRequest({ url: 'https://www.firmy.cz/' });
    }

    // Define a pattern of URLs that the crawler should visit
    const itemSelector = 'a.companyTitle.statCompanyDetail';
    const pageSelector = 'a.imgLink, #nextBtn';
    const pseudoUrls = [new Apify.PseudoUrl('https://www.firmy.cz/[.+]')];

    // Create a crawler that will use headless Chrome / Puppeteer to extract data
    // from pages and recursively add links to newly-found pages
    const crawler = new Apify.PuppeteerCrawler({
        requestList,
        requestQueue,

        launchPuppeteerOptions: input.proxyConfiguration || {
            useApifyProxy: true
        },

        // This function is called for every page the crawler visits
        handlePageFunction: async ({ request, page }) => {
            if(request.url.includes('/detail/')){
                // Process detail page
                
                // Extract data
                try{await page.waitFor('[itemprop="ratingCount"]');}
                catch(e){console.log('No rating count found.');}
                await Apify.utils.puppeteer.injectJQuery(page);
                const myResult = await page.evaluate(extractData);
                myResult.url = request.url;

                // Extract extended data
                let userResult = {};
                try {
                    await page.evaluate(`window.eoFn = ${input.extendOutputFunction};`);
                    userResult = await page.evaluate(async () => 
                        JSON.stringify(await eoFn($), (k, v) => v === undefined ? 'to_be_deleted' : v)
                    );
                    userResult = JSON.parse(userResult);
                    Object.keys(userResult).map(function(key, index) {
                        if(userResult[key] === 'to_be_deleted'){
                            userResult[key] = undefined;
                        }
                    });
                } catch (e) {
                    console.log(`extendOutputFunction crashed! Pushing default output. Please fix your function if you want to update the output. Error: ${e}`);
                }

                // Check extended data
                if (!isObject(userResult)) {
                    console.log('extendOutputFunction has to return an object!');
                    process.exit(1);
                }
                
                // Merge basic and extended data
                const result = Object.assign(myResult, userResult);

                // Return result and check if maximum count has been reached
                await dataset.pushData(result);
                if(input.maxItems && ++itemCount >= input.maxItems){
                    console.log('Maximum item count reached, finishing...');
                    process.exit(0);
                }
            }
            else{
                // Process other pages
                
                // Enqueue company details
                try{await page.waitFor(itemSelector);}
                catch(e){console.log('No company detail links found.');}
                const itemLinks = await page.$$(itemSelector);
                for(const link of itemLinks){
                    const url = await getAttribute(link, 'href');
                    await requestQueue.addRequest({url});
                }
                
                // Enqueue sub-pages
                try{await page.waitFor(pageSelector);}
                catch(e){console.log('No sub-pages found.');}
                const pageLinks = await page.$$(pageSelector);
                for(const link of pageLinks){
                    const url = await getAttribute(link, 'href');
                    await requestQueue.addRequest({url});
                }
            }
        },

        // This function is called for every page the crawler failed to load
        // or for which the handlePageFunction() throws at least "maxRequestRetries"-times
        handleFailedRequestFunction: async ({ request }) => {
            console.log(`Request ${request.url} failed too many times`);
            await Apify.pushData({
                '#debug': Apify.utils.createRequestDebugInfo(request),
            });
        },
        
        // This function is called every time the crawler is supposed to go to a new page
        gotoFunction: async function({ page, request, puppeteerPool }){
            try{
                await Apify.utils.puppeteer.blockRequests(page);
                return await Apify.utils.puppeteer.gotoExtended(page, request, { timeout: this.gotoTimeoutMillis });
            }
            catch(e){throw e;}
        },

        maxRequestRetries: 3
    });

    await crawler.run();
});
