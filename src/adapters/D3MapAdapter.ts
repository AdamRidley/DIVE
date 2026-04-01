import * as d3 from 'd3';
import { IAdapter } from '../core/Adapter';

export class D3MapAdapter implements IAdapter {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private container: HTMLElement | null = null;
  private projection: d3.GeoProjection | null = null;
  private zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;
  
  mount(container: HTMLElement, data: any[]): void {
    this.container = container;
    
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;

    this.svg = d3.select(container).append("svg")
      .attr("width", width)
      .attr("height", height);

    // Use a simple Equirectangular projection
    this.projection = d3.geoEquirectangular()
      .scale(height / Math.PI)
      .translate([width / 2, height / 2]);

    const path = d3.geoPath().projection(this.projection);

    // Draw some dummy borders or graticules since we lack a real GeoJSON in the PoC
    this.svg.append('path')
      .datum(d3.geoGraticule10())
      .attr('d', path)
      .attr('fill', 'none')
      .attr('stroke', '#ccc');

    // Draw bubbles based on coordinates
    const g = this.svg.append('g');
    
    g.selectAll("circle")
      .data(data)
      .join("circle")
        .attr("class", "node")
        .attr("cx", d => {
          const pt = this.projection!([d.lng, d.lat]);
          return pt ? pt[0] : 0;
        })
        .attr("cy", d => {
          const pt = this.projection!([d.lng, d.lat]);
          return pt ? pt[1] : 0;
        })
        .attr("r", d => Math.max(2, Math.sqrt(d.population) / 2000))
        .attr("fill", "teal")
        .attr("opacity", 0.6);

    g.selectAll("text")
      .data(data)
      .join("text")
        .attr("x", d => {
          const pt = this.projection!([d.lng, d.lat]);
          return pt ? pt[0] : 0;
        })
        .attr("y", d => {
          const pt = this.projection!([d.lng, d.lat]);
           const r = Math.max(2, Math.sqrt(d.population) / 2000);
          return pt ? pt[1] - r - 4 : 0;
        })
        .text(d => d.country)
        .style("font-family", "sans-serif")
        .style("font-size", "10px")
        .style("text-anchor", "middle")
        .style("fill", "#333");

    this.zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 8])
      .on("zoom", (event) => {
        this.svg!.selectAll("path, g")
          .attr("transform", event.transform);
      });
      
    this.svg.call(this.zoomBehavior);
  }

  setState(state: any, _timeMs?: number): void {
    if (!this.svg || !this.zoomBehavior) return;
    
    if (state.panTo) {
      if (state.panTo === "Asia") {
        this.svg.transition().duration(1000)
          .call(this.zoomBehavior.transform as any, d3.zoomIdentity.translate(-200, 50).scale(2));
      } else if (state.panTo === "Europe") {
        this.svg.transition().duration(1000)
          .call(this.zoomBehavior.transform as any, d3.zoomIdentity.translate(50, 150).scale(2.5));
      } else {
        this.svg.transition().duration(1000)
          .call(this.zoomBehavior.transform as any, d3.zoomIdentity); // reset
      }
    }
  }

  unmount(): void {
    if (this.container && this.svg) {
      d3.select(this.container).selectAll("*").remove();
    }
    this.svg = null;
  }
}
