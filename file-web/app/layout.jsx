import './globals.css';
import localFont from 'next/font/local';

const bodyFont = localFont({ src: './fonts/dm-sans.woff2', variable: '--font-body', display: 'swap', weight: '400 700' });
const displayFont = localFont({ src: './fonts/manrope.woff2', variable: '--font-display', display: 'swap', weight: '600 800' });

export const metadata = {
  title: 'Hippy Files',
  description: 'Kho tệp riêng tư cho tài khoản hippy.vn',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
};

export const viewport = { themeColor: '#102b21', width: 'device-width', initialScale: 1 };
const buildId = process.env.FILE_BUILD_SHA || process.env.NEXT_PUBLIC_FILE_BUILD_SHA || 'dev';

export default function RootLayout({children}) {
  return <html lang="vi"><head><meta name="file-build-sha" content={buildId}/></head><body className={`${bodyFont.variable} ${displayFont.variable}`}>{children}<script dangerouslySetInnerHTML={{__html:"if('serviceWorker'in navigator)addEventListener('load',()=>navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).then(r=>r.update()).catch(()=>{}))"}} /></body></html>;
}
