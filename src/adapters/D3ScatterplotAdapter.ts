import * as d3 from 'd3';
import { IAdapter } from '../core/Adapter';

export class D3ScatterplotAdapter implements IAdapter {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined> | null = null;
  private x: d3.ScaleLinear<number, number> | null = null;
  private y: d3.ScaleLinear<number, number> | null = null;
  private data: any[] = [];
  private container: HTMLElement | null = null;

  private zoomBehavior: d3.ZoomBehavior<SVGSVGElement, unknown> | null = null;

  mount(container: HTMLElement, data: any[]): void {
    this.container = container;
    this.data = data || [];
    
    // Setup basic D3 scatterplot
    const width = container.clientWidth || 800;
    const height = container.clientHeight || 500;
    const margin = { top: 20, right: 20, bottom: 40, left: 50 };

    this.svg = d3.select(container).append("svg")
      .attr("width", width)
      .attr("height", height);

    this.x = d3.scaleLinear()
      .domain((d3.extent(this.data, d => d.gdp) as [number, number]) || [0, 100])
      .range([margin.left, width - margin.right]);

    this.y = d3.scaleLinear()
      .domain((d3.extent(this.data, d => d.energy) as [number, number]) || [0, 100])
      .range([height - margin.bottom, margin.top]);

    const r = d3.scaleSqrt()
      .domain((d3.extent(this.data, d => d.population) as [number, number]) || [0, 100])
      .range([2, 30]);

    // Add axes
    this.svg.append("g")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(this.x));

    this.svg.append("g")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(this.y));

    // Add dots
    const g = this.svg.append('g');
    
    // Add dots
    g.selectAll("circle")
      .data(this.data)
      .join("circle")
        .attr("class", "dot")
        .attr("cx", d => this.x!(d.gdp))
        .attr("cy", d => this.y!(d.energy))
        .attr("r", d => r(d.population))
        .attr("fill", "steelblue")
        .attr("opacity", 0.7);

    // Add labels
    g.selectAll("text")
      .data(this.data)
      .join("text")
        .attr("class", "label")
        .attr("x", d => this.x!(d.gdp) + r(d.population) + 2)
        .attr("y", d => this.y!(d.energy) + 4)
        .text(d => d.country)
        .style("font-family", "sans-serif")
        .style("font-size", "10px")
        .style("fill", "#333");
        
    // Standard setup: Add zoom behavior for user exploration
    this.zoomBehavior = d3.zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.5, 5])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      });
      
    this.svg.call(this.zoomBehavior);
  }

  setState(state: any, timeMs?: number): void {
    if (!this.svg) return;
    
    // State might contain highlights: "highlight": "USA"
    if (state.highlight) {
      this.svg.selectAll(".dot")
        .transition().duration(500)
        .attr("fill", (d: any) => d.country === state.highlight ? "orange" : "steelblue")
        .attr("opacity", (d: any) => d.country === state.highlight ? 1 : 0.2);
        
      this.svg.selectAll(".label")
        .transition().duration(500)
        .style("opacity", (d: any) => d.country === state.highlight ? 1 : 0);
    } else {
      this.svg.selectAll(".dot")
        .transition().duration(500)
        .attr("fill", "steelblue")
        .attr("opacity", 0.7);

      this.svg.selectAll(".label")
        .transition().duration(500)
        .style("opacity", 1);
    }

    // Handle automated zooming / panning state
    if (state.zoom && this.zoomBehavior) {
      // Very basic mock of automated zooming
      const transform = d3.zoomIdentity.translate(state.zoom.x || 0, state.zoom.y || 0).scale(state.zoom.k || 1);
      this.svg.transition().duration(state.duration || 1000)
        .call(this.zoomBehavior.transform as any, transform);
    }
  }

  unmount(): void {
    if (this.container && this.svg) {
      d3.select(this.container).selectAll("*").remove();
    }
    this.svg = null;
  }
}
