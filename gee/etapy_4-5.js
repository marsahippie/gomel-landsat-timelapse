// ---------------------------------------------------------------------
// ЭТАП 4 (функция). ГОДОВОЙ КОМПОЗИТ
// ---------------------------------------------------------------------
function makeComposite(year) {
  var m = seasonMonths(year);
  var s = ee.Date.fromYMD(year, m[0], 1);
  var e = ee.Date.fromYMD(year, m[1], 1);

  // Все чистые (без облаков) снимки года со всех четырёх спутников
  var col = lt5.filterDate(s, e).map(prepTM)
    .merge(le7.filterDate(s, e).map(prepTM))
    .merge(lc8.filterDate(s, e).map(prepOLI))
    .merge(lc9.filterDate(s, e).map(prepOLI));

  // Медиана «сшивает» сцены в одну картинку, обрезаем по рамке, добавляем индексы
  var img = addIndices(col.median().clip(aoi)).toFloat();

  return img.set({
    year: year,
    n_scenes: col.size(),  // сколько сцен вошло — пригодится для проверки
    'system:time_start': ee.Date.fromYMD(year, 7, 1).millis()
  });
}


// ---------------------------------------------------------------------
// СТРОИМ КОМПОЗИТЫ ДЛЯ ВСЕХ ЛЕТ
// ---------------------------------------------------------------------
var compositeByYear = {};   // словарь «год -> изображение»
var imgList = [];
for (var y = START_YEAR; y <= END_YEAR; y++) {
  var c = makeComposite(y);
  compositeByYear[y] = c;
  imgList.push(c);
}
// Единая коллекция всех композитов — понадобится на этапе экспорта
var composites = ee.ImageCollection.fromImages(imgList);

print('Композитов построено:', composites.size());
print('Каналы композита:', compositeByYear[START_YEAR].bandNames());


// ---------------------------------------------------------------------
// ПАРАМЕТРЫ ОТОБРАЖЕНИЯ СЛОЁВ
// ---------------------------------------------------------------------
var PAL_GREEN = ['#ffffcc', '#c2e699', '#78c679', '#31a354', '#006837'];
var PAL_MOIST = ['#8c510a', '#f6e8c3', '#c7eae5', '#35978f', '#01665e'];
var PAL_BUILT = ['#1a9641', '#ffffbf', '#d7191c'];
var PAL_WATER = ['#a6611a', '#ffffff', '#2166ac'];

// min/max — границы шкалы цветов. Если картинка слишком тусклая или
// пёстрая, поменяйте эти числа.
var LAYERS = {
  'RGB (естественные цвета)': {bands: ['Red', 'Green', 'Blue'], min: 0, max: 0.25, gamma: 1.2},
  'NDVI (растительность)': {bands: ['NDVI'], min: 0, max: 0.9, palette: PAL_GREEN},
  'NBR (вырубки, гари)': {bands: ['NBR'], min: 0, max: 0.8, palette: PAL_GREEN},
  'NDMI (влажность растительности)': {bands: ['NDMI'], min: -0.3, max: 0.5, palette: PAL_MOIST},
  'NDBI (застройка)': {bands: ['NDBI'], min: -0.4, max: 0.2, palette: PAL_BUILT},
  'BUI (застройка: NDBI − NDVI)': {bands: ['BUI'], min: -0.8, max: 0.2, palette: PAL_BUILT},
  'MNDWI (вода)': {bands: ['MNDWI'], min: -0.6, max: 0.6, palette: PAL_WATER},
  'NDWI (вода, классический)': {bands: ['NDWI'], min: -0.6, max: 0.4, palette: PAL_WATER}
};


// ---------------------------------------------------------------------
// ПРОСМОТРЩИК: ползунок года + выбор слоя
// ---------------------------------------------------------------------

// Убираем тестовые слои этапа 3 и собираем карту заново
Map.layers().reset();
Map.addLayer(ee.Image(0).selfMask(), {}, 'Растр');   // слой №0 — сюда выводим выбранный год
Map.addLayer(ramka.style({color: '0000FF', fillColor: '00000000', width: 2}), {}, 'Рамка (синяя)');
Map.addLayer(rayon.style({color: 'FF0000', fillColor: '00000000', width: 2}), {}, 'Район (красный)');

var infoLabel = ui.Label('');

var layerSelect = ui.Select({
  items: Object.keys(LAYERS),
  value: Object.keys(LAYERS)[0],
  onChange: showLayer,
  style: {stretch: 'horizontal'}
});

var yearSlider = ui.Slider({
  min: START_YEAR,
  max: END_YEAR,
  value: START_YEAR,
  step: 1,
  onChange: showLayer,
  style: {stretch: 'horizontal'}
});

Map.add(ui.Panel(
  [ui.Label('Год:'), yearSlider, ui.Label('Слой:'), layerSelect, infoLabel],
  ui.Panel.Layout.flow('vertical'),
  {position: 'top-right', width: '330px'}
));

// Показывает на карте выбранный год и слой
function showLayer() {
  var year = yearSlider.getValue();
  var name = layerSelect.getValue();
  var img = compositeByYear[year];
  Map.layers().set(0, ui.Map.Layer(img, LAYERS[name], name + ' ' + year));
  img.get('n_scenes').evaluate(function (n) {
    infoLabel.setValue('Год ' + year + ': в композит вошло сцен — ' + n);
  });
}

showLayer();  // первый показ