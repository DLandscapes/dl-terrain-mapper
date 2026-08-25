// QGIS style files, written the way QGIS writes them.
//
// ⚠️ BOTH PROPERTY DIALECTS ARE PRODUCED HERE ON PURPOSE. QGIS 3.20 and later
// writes <Option name= value=>; everything before it wrote <prop k= v=>. Style
// libraries outlive QGIS versions, so a reader that knows only the current one
// silently returns an empty style for a file somebody saved in 2019.

/** QGIS 3.20+ : Option elements. */
const optionProps = (props) => Object.entries(props)
  .map(([k, v]) => `          <Option type="QString" name="${k}" value="${v}"/>`).join("\n");

/** Older QGIS : prop elements. */
const oldProps = (props) => Object.entries(props)
  .map(([k, v]) => `          <prop k="${k}" v="${v}"/>`).join("\n");

/**
 * A line-layer QML.
 * @param {{colour?:string, width?:string, widthUnit?:string, style?:string,
 *          customDash?:string, useCustomDash?:boolean, dialect?:"option"|"prop",
 *          labels?:boolean, fontSize?:string, fontUnit?:string, field?:string,
 *          renderer?:string, attribute?:string, extraSymbols?:object[],
 *          symbolLayerClass?:string, offset?:string, version?:string}} [o]
 */
export function makeQML(o = {}) {
  const dialect = o.dialect === "prop" ? oldProps : optionProps;
  const props = {
    align_dash_pattern: "0",
    capstyle: "square",
    customdash: o.customDash ?? "5;2",
    customdash_unit: "MM",
    dash_pattern_offset: "0",
    joinstyle: "bevel",
    line_color: o.colour ?? "35,35,35,255,rgb:0.137,0.137,0.137,1",
    line_style: o.style ?? "solid",
    line_width: o.width ?? "0.26",
    line_width_unit: o.widthUnit ?? "MM",
    offset: o.offset ?? "0",
    use_custom_dash: o.useCustomDash ? "1" : "0",
  };
  const symbol = (name, cls) => `      <symbol type="line" name="${name}" alpha="1" clip_to_extent="1">
        <layer class="${cls || "SimpleLine"}" locked="0" pass="0" enabled="1">
          <Option type="Map">
${dialect(props)}
          </Option>
${dialect === oldProps ? dialect(props) : ""}
        </layer>
      </symbol>`;

  const extra = (o.extraSymbols || []).map((e, i) => symbol(String(i + 1), e.cls)).join("\n");
  const classes = (o.extraSymbols || []).map((e, i) =>
    o.renderer === "graduatedSymbol"
      ? `      <range lower="${i * 10}" upper="${(i + 1) * 10}" symbol="${i + 1}" label="${e.label}" render="true"/>`
      : `      <category value="${e.label}" symbol="${i + 1}" label="${e.label}" render="true"/>`).join("\n");
  const classBlock = !classes ? "" :
    (o.renderer === "graduatedSymbol" ? `    <ranges>\n${classes}\n    </ranges>\n`
                                      : `    <categories>\n${classes}\n    </categories>\n`);

  const labelling = o.labels === false ? "" : `  <labeling type="simple">
    <settings calloutType="simple">
      <text-style fontFamily="Open Sans" fontSize="${o.fontSize ?? "8"}"
        fontSizeUnit="${o.fontUnit ?? "Point"}" textColor="0,0,0,255"
        fieldName="${o.field ?? "ELEV"}" isExpression="0"/>
      <placement placement="2"/>
    </settings>
  </labeling>
`;

  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="${o.version ?? "3.44.12-Solothurn"}" styleCategories="AllStyleCategories" labelsEnabled="${o.labels === false ? 0 : 1}">
  <renderer-v2 type="${o.renderer ?? "singleSymbol"}"${o.attribute ? ` attr="${o.attribute}"` : ""} symbollevels="0" forceraster="0">
${classBlock}    <symbols>
${symbol("0", o.symbolLayerClass)}
${extra}
    </symbols>
  </renderer-v2>
${labelling}</qgis>
`;
}

/** An SLD, the OGC interchange form. */
export function makeSLD(o = {}) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<StyledLayerDescriptor xmlns="http://www.opengis.net/sld" version="1.1.0"
  xmlns:se="http://www.opengis.net/se" xmlns:ogc="http://www.opengis.net/ogc">
  <NamedLayer>
    <se:Name>contours</se:Name>
    <UserStyle>
      <se:FeatureTypeStyle>
        <se:Rule>
          <se:Name>Single symbol</se:Name>
          <se:LineSymbolizer>
            <se:Stroke>
              <se:SvgParameter name="stroke">${o.colour ?? "#1f78b4"}</se:SvgParameter>
              <se:SvgParameter name="stroke-width">${o.width ?? "0.96"}</se:SvgParameter>
              <se:SvgParameter name="stroke-linejoin">bevel</se:SvgParameter>
              ${o.dash ? `<se:SvgParameter name="stroke-dasharray">${o.dash}</se:SvgParameter>` : ""}
            </se:Stroke>
          </se:LineSymbolizer>
          ${o.labels ? `<se:TextSymbolizer>
            <se:Font><se:SvgParameter name="font-size">9</se:SvgParameter></se:Font>
          </se:TextSymbolizer>` : ""}
        </se:Rule>
      </se:FeatureTypeStyle>
    </UserStyle>
  </NamedLayer>
</StyledLayerDescriptor>
`;
}
