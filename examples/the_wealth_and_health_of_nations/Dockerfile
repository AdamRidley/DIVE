# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY . ./
RUN npm ci --legacy-peer-deps || npm install
RUN npx vite build -c examples/the_wealth_and_health_of_nations/vite.config.example.mjs
# Serve stage
FROM nginx:stable-alpine
COPY --from=build /app/dist-example /usr/share/nginx/html
COPY examples/the_wealth_and_health_of_nations/story.json /usr/share/nginx/html/
COPY examples/the_wealth_and_health_of_nations/data/ /usr/share/nginx/html/data/
COPY examples/the_wealth_and_health_of_nations/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
