DO deployment instructions:

cd ../var/www/step-tracker-backend/ && git pull origin main && npm install && npx prisma migrate deploy && npx prisma generate && node prisma/seed.js && pm2 restart 3    