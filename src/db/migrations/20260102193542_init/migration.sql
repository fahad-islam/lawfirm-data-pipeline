/*
  Warnings:

  - A unique constraint covering the columns `[url]` on the table `GooglePlaceUrlToScrape` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "GooglePlaceUrlToScrape_url_key" ON "GooglePlaceUrlToScrape"("url");
