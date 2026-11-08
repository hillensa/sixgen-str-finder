/**
 * The "Send to Sixgen" bookmark.
 *
 * Seth drags it to his bookmarks bar once. On a Zillow results page he opened
 * himself, one click reads the homes that page already rendered and copies
 * them to the clipboard for the /zillow page to take. It runs as him, in his
 * own browser, so it never meets the bot protection that blocks an automated
 * pull — and it makes no requests of its own.
 *
 * Kept as a plain string rather than a compiled function on purpose: the
 * bundler is free to rewrite a function (helpers, downlevelling) into something
 * that no longer runs standalone on zillow.com. Written in ES2017 with no
 * module-scope references, and only these globals: document, sessionStorage,
 * navigator, location, alert, setTimeout.
 *
 * Pages accumulate in zillow.com's sessionStorage, so after the last page the
 * clipboard holds the whole search. Page 1, or a change of filters, starts over.
 */
export const BOOKMARKLET_SOURCE = String.raw`(function(){
var KEY='sixgen-zillow-pull';
function toast(t,bad){var d=document.createElement('div');d.textContent=t;d.style.cssText='position:fixed;z-index:2147483647;top:16px;left:50%;transform:translateX(-50%);max-width:560px;padding:12px 16px;border-radius:10px;font:600 14px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.3);background:'+(bad?'#b91c1c':'#14213d');document.body.appendChild(d);setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d);},bad?9000:7000);}
var el=document.getElementById('__NEXT_DATA__');
if(!el){alert('Sixgen: open a Zillow search results page first.');return;}
var nd;try{nd=JSON.parse(el.textContent);}catch(e){alert('Sixgen: could not read this Zillow page.');return;}
var sps=nd&&nd.props&&nd.props.pageProps&&nd.props.pageProps.searchPageState;
var cat=sps&&sps.cat1;var list=(cat&&cat.searchResults&&cat.searchResults.listResults)||[];
if(!sps||!cat){alert('Sixgen: this is not a Zillow search results page.');return;}
var qs=sps.queryState||{};var f=qs.filterState||{};
var page=(qs.pagination&&qs.pagination.currentPage)||1;
var m=String(location.pathname).match(/\/(\d+)_p\/?$/);var urlPage=m?Number(m[1]):1;
if(urlPage!==page){toast('Sixgen: Zillow changed pages without reloading, so this page still holds page '+page+'. Reloading — click the bookmark again once it loads.',true);setTimeout(function(){location.reload();},1500);return;}
if(!list.length){toast('Sixgen: no homes on this page.',true);return;}
var sig=(f.beds&&f.beds.min!=null&&f.baths&&f.baths.min!=null&&f.hoa&&f.hoa.max!=null)?('beds>='+f.beds.min+'|baths>='+f.baths.min+'|hoa<='+f.hoa.max):null;
var sl=cat.searchList||{};var total=sl.totalResultCount!=null?sl.totalResultCount:null;var totalPages=sl.totalPages!=null?sl.totalPages:null;
function pick(a,b){return a!=null?a:(b!=null?b:null);}
var homes=list.map(function(r){var h=(r.hdpData&&r.hdpData.homeInfo)||{};var ll=r.latLong||{};
var lot=h.lotAreaValue==null?null:Math.round(h.lotAreaUnit==='acres'?h.lotAreaValue*43560:h.lotAreaValue);
return {zpid:String(r.zpid),address:h.streetAddress||r.addressStreet||'',zip:h.zipcode||r.addressZipcode||null,
lat:pick(h.latitude,ll.latitude),lng:pick(h.longitude,ll.longitude),price:pick(h.price,r.unformattedPrice),
beds:pick(h.bedrooms,r.beds),baths:pick(h.bathrooms,r.baths),sqft:pick(h.livingArea,r.area),lotSqft:lot,
homeType:h.homeType||null,dom:pick(h.daysOnZillow,null),photo:r.imgSrc||null};});
var acc=null;try{acc=JSON.parse(sessionStorage.getItem(KEY)||'null');}catch(e){}
if(!acc||acc.signature!==sig||page===1){acc={sixgen:'zillow-pull',v:1,signature:sig,total:total,totalPages:totalPages,pages:[],homes:[]};}
var byId={};acc.homes.forEach(function(h){byId[h.zpid]=h;});homes.forEach(function(h){byId[h.zpid]=h;});
acc.homes=Object.keys(byId).map(function(k){return byId[k];});
if(acc.pages.indexOf(page)<0)acc.pages.push(page);acc.pages.sort(function(a,b){return a-b;});
acc.total=total;acc.totalPages=totalPages;
try{sessionStorage.setItem(KEY,JSON.stringify(acc));}catch(e){}
var text=JSON.stringify(acc);
var done=totalPages!=null&&acc.pages.length>=totalPages;
var msg='Sixgen: copied page '+page+(totalPages?' of '+totalPages:'')+' — '+acc.homes.length+(total!=null?' of '+total:'')+' homes so far. '+(done?'All pages collected: paste into Sixgen and import.':'Paste into Sixgen, then click Next here and run this again.');
function manual(){var o=document.createElement('div');o.style.cssText='position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center';
var b=document.createElement('div');b.style.cssText='background:#fff;padding:16px;border-radius:12px;width:min(560px,90vw);font:14px system-ui,sans-serif';
b.innerHTML='<b>Sixgen: press Ctrl+C to copy, then close this.</b>';var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='width:100%;height:160px;margin:8px 0';
var x=document.createElement('button');x.textContent='Close';x.onclick=function(){o.parentNode.removeChild(o);};
b.appendChild(ta);b.appendChild(x);o.appendChild(b);document.body.appendChild(o);ta.focus();ta.select();}
function fallback(){var ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;top:-1000px;left:0';document.body.appendChild(ta);ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);if(ok)toast(msg);else manual();}
if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(text).then(function(){toast(msg);},fallback);}else{fallback();}
})()`;

/** The href for the draggable link. */
export function bookmarkletHref(): string {
  return "javascript:" + encodeURIComponent(BOOKMARKLET_SOURCE);
}
