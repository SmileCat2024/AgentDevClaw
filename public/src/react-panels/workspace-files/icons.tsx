/**
 * 文件类型图标（对齐 DeepSeek harness 的 ui-primitives 实践）：
 * - 代码/配置文件：code-file-types.ts 分类 → code-file-icon-artwork.ts 全彩方章图标（两文件自 DSH 照搬）
 * - 传统类型（code/excel/html/image/markdown/pdf/ppt/video/word/other）：28×28「页身 + 类型角标」glyph，
 *   路径照搬 DSH FileTypeIcon.tsx，配色按类型落在 style.css 的 .wf-ft-* 类
 * - 文件树目录行：folder-open / folder-close 16px 线性图标（照搬 DSH icons/artwork.ts，currentColor）
 */
import { useId } from 'react';
import type { ReactNode } from 'react';
import {
  CODE_FILE_ARTWORK,
  CODE_FILE_ICON_ID_TOKEN,
} from './code-file-icon-artwork.ts';
import {
  classifyCodeFileType,
  isCodeFileType,
  type CodeFileType,
} from './code-file-types.ts';

type IconProps = { readonly size?: number; readonly className?: string };

/** 代码文件全彩方章图标（照搬 DSH CodeFileIcon：实例 id 替换保证渐变/裁剪隔离）。 */
export function CodeFileIcon({ type, size = 20, className }: IconProps & { readonly type: CodeFileType }): ReactNode {
  const instanceId = `wf-code-icon-${useId().replaceAll(':', '')}`;
  const artwork = CODE_FILE_ARTWORK[type].replaceAll(CODE_FILE_ICON_ID_TOKEN, instanceId);
  return (
    <svg
      width={size}
      height={size}
      className={className}
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: artwork }}
    />
  );
}

/** 传统文件类型集合（code 之外的四角标类型）。 */
export type TraditionalFileType =
  | 'code' | 'excel' | 'html' | 'image' | 'markdown' | 'other' | 'pdf' | 'ppt' | 'video' | 'word';

export type AnyFileType = CodeFileType | TraditionalFileType;

const TRADITIONAL_NAME_TYPES = new Map<string, TraditionalFileType>([
  ['changelog', 'markdown'],
  ['contributing', 'markdown'],
  ['readme', 'markdown'],
]);

const TRADITIONAL_EXTENSION_TYPES = new Map<string, TraditionalFileType>(Object.entries({
  scss: 'code', sass: 'code', less: 'code', vue: 'code', svelte: 'code', astro: 'code',
  bat: 'code', cmd: 'code',
  csv: 'excel', tsv: 'excel',
  html: 'html', htm: 'html',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image',
  avif: 'image', bmp: 'image', ico: 'image', tif: 'image', tiff: 'image', heic: 'image', heif: 'image',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  pdf: 'pdf',
  ppt: 'ppt', pptx: 'ppt', key: 'ppt',
  mp4: 'video', mov: 'video', m4v: 'video', webm: 'video', mkv: 'video', avi: 'video', mpg: 'video', mpeg: 'video',
  doc: 'word', docx: 'word', rtf: 'word', odt: 'word', pages: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', xlsb: 'excel', xlt: 'excel', xltx: 'excel',
  xltm: 'excel', ods: 'excel', ots: 'excel', fods: 'excel', numbers: 'excel',
}));

function basename(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

function fileExtension(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot + 1);
}

/** 分类入口（对齐 DSH classifyFileType：代码名规则优先 → 传统名 → 传统扩展 → other）。 */
export function classifyFileType(path: string): AnyFileType {
  const name = basename(path).toLowerCase();
  const extension = fileExtension(name).toLowerCase();
  return classifyCodeFileType(name, extension)
    ?? TRADITIONAL_NAME_TYPES.get(name)
    ?? TRADITIONAL_EXTENSION_TYPES.get(extension)
    ?? 'other';
}

/* ---- 传统 glyph：页身几何与类型角标（路径照搬 DSH FileTypeIcon.tsx） ---- */

const FILE_BODY = 'M8.48924 28H19.5108C21.6479 28 22.7165 28 23.5594 27.6509C24.6833 27.1853 25.5762 26.2924 26.0417 25.1685C26.3909 24.3256 26.3909 23.257 26.3909 21.1199V8.79443C26.3909 8.32877 26.3909 8.09593 26.3471 7.87507C26.2887 7.58058 26.173 7.30042 26.0067 7.05048C25.882 6.86303 25.7177 6.69799 25.3893 6.36792L20.0611 1.01354C19.7304 0.681235 19.5651 0.515081 19.3769 0.38885C19.126 0.220541 18.8443 0.103463 18.5481 0.0443412C18.3259 0 18.0915 0 17.6226 0H8.48924C6.35209 0 5.28351 0 4.4406 0.349145C3.31672 0.814671 2.4238 1.70759 1.95828 2.83147C1.60913 3.67438 1.60913 4.74296 1.60913 6.88011V21.1199C1.60913 23.257 1.60913 24.3256 1.95828 25.1685C2.4238 26.2924 3.31672 27.1853 4.4406 27.6509C5.28351 28 6.35209 28 8.48924 28Z';
const FILE_FOLD = 'M26.3909 7.37445L19.0525 0V3.77445C19.0525 4.89271 19.0525 5.45184 19.2352 5.89289C19.4788 6.48096 19.946 6.94818 20.5341 7.19176C20.9751 7.37445 21.5342 7.37445 22.6525 7.37445H26.3909Z';
const FILE_MARK_TRANSFORM = 'translate(14 16) scale(1.12) translate(-14 -16)';
const LARGE_FILE_MARK_TRANSFORM = 'translate(14 16) scale(1.22) translate(-14 -16)';

function FileGlyph({ size, className, children, markTransform, muted = false }: IconProps & {
  children?: ReactNode; markTransform?: string; muted?: boolean;
}): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d={FILE_BODY} fill="currentColor" />
      <path d={FILE_FOLD} fill={muted ? '#9aa4b2' : '#ffffff'} fillOpacity={muted ? undefined : '.7'} />
      {children !== undefined && (
        <g color="#ffffff" data-file-type-mark transform={markTransform}>{children}</g>
      )}
    </svg>
  );
}

function SpreadsheetGlyph({ size, className }: IconProps): ReactNode {
  return (
    <FileGlyph size={size} className={className}>
      <path
        d="M14 11.5H11.4C10.5599 11.5 10.1399 11.5 9.81901 11.6635C9.53677 11.8073 9.3073 12.0368 9.16349 12.319C9 12.6399 9 13.0599 9 13.9V16.5M14 11.5H16.6C17.4401 11.5 17.8601 11.5 18.181 11.6635C18.4632 11.8073 18.6927 12.0368 18.8365 12.319C19 12.6399 19 13.0599 19 13.9V16.5M14 11.5V21.5M14 21.5H16.6C17.4401 21.5 17.8601 21.5 18.181 21.3365C18.4632 21.1927 18.6927 20.9632 18.8365 20.681C19 20.3601 19 19.9401 19 19.1V16.5M14 21.5H11.4C10.5599 21.5 10.1399 21.5 9.81901 21.3365C9.53677 21.1927 9.3073 20.9632 9.16349 20.681C9 20.3601 9 19.9401 9 19.1V16.5M19 16.5H9"
        stroke="currentColor" strokeWidth="1.2"
      />
    </FileGlyph>
  );
}

function traditionalGlyph(type: TraditionalFileType, size: number, className: string | undefined): ReactNode {
  switch (type) {
    case 'code':
      return (
        <FileGlyph size={size} className={className}>
          <path d="M10.0053 13.126L7.0236 16.3788C6.96052 16.4476 6.96052 16.5532 7.0236 16.622L10.0053 19.8748" stroke="currentColor" strokeWidth="1.35" />
          <path d="M17.9941 13.126L20.9759 16.3788C21.039 16.4476 21.039 16.5532 20.9759 16.622L17.9941 19.8748" stroke="currentColor" strokeWidth="1.35" />
          <path d="M15.2652 12.957L12.7344 20.0433" stroke="currentColor" strokeWidth="1.35" />
        </FileGlyph>
      );
    case 'excel': return <SpreadsheetGlyph size={size} className={className} />;
    case 'html':
      return (
        <FileGlyph size={size} className={className} markTransform={FILE_MARK_TRANSFORM}>
          <path
            fillRule="evenodd" clipRule="evenodd"
            d="M13.9994 9.68298C17.212 9.68298 19.8167 12.2872 19.8168 15.4997C19.8168 18.7123 17.2121 21.3171 13.9994 21.3171C10.7869 21.3169 8.18274 18.7122 8.18274 15.4997C8.1829 12.2873 10.787 9.68315 13.9994 9.68298ZM9.26213 16.0247C9.47025 17.9241 10.7936 19.4876 12.5639 20.0463C12.42 19.7977 12.2952 19.5152 12.1879 19.2116C11.885 18.3541 11.693 17.2434 11.6424 16.0247H9.26213ZM16.3565 16.0247C16.3059 17.2434 16.1145 18.3542 15.8116 19.2116C15.7044 19.5151 15.5788 19.7971 15.435 20.0456C17.2054 19.487 18.5293 17.9242 18.7374 16.0247H16.3565ZM12.6938 16.0247C12.7439 17.1459 12.9212 18.1334 13.1784 18.8616C13.332 19.2962 13.503 19.61 13.6686 19.805C13.834 19.9996 13.9473 20.0256 13.9994 20.0258C14.0514 20.0258 14.1651 20.0002 14.331 19.805C14.4966 19.61 14.6676 19.2962 14.8211 18.8616C15.0784 18.1334 15.2557 17.1459 15.3058 16.0247H12.6938ZM13.9994 10.733C13.9473 10.7331 13.834 10.7598 13.6686 10.9545C13.503 11.1494 13.3319 11.4633 13.1784 11.8978C12.903 12.6777 12.7188 13.7545 12.6849 14.9747H15.3147C15.2808 13.7545 15.0966 12.6777 14.8211 11.8978C14.6676 11.4633 14.4965 11.1494 14.331 10.9545C14.1651 10.7593 14.0514 10.733 13.9994 10.733ZM15.5888 11.0051C15.6701 11.1756 15.7444 11.3576 15.8116 11.5478C16.1343 12.4613 16.3308 13.6619 16.3647 14.9747H18.7374C18.5352 13.1307 17.2817 11.6036 15.5888 11.0051ZM12.4101 11.0051C10.7174 11.6037 9.46428 13.1308 9.26213 14.9747H11.6349C11.6688 13.6619 11.8652 12.4613 12.1879 11.5478C12.2551 11.3577 12.3288 11.1756 12.4101 11.0051Z"
            fill="currentColor"
          />
        </FileGlyph>
      );
    case 'image':
      return (
        <FileGlyph size={size} className={className} markTransform={FILE_MARK_TRANSFORM}>
          <path d="M10.4212 15.9204C10.5756 15.6558 10.9579 15.6558 11.1123 15.9204L13.6493 20.2696C13.8048 20.5362 13.6125 20.8711 13.3037 20.8711H8.22974C7.92102 20.8711 7.72868 20.5362 7.88423 20.2696L10.4212 15.9204Z" fill="currentColor" />
          <path d="M15.4981 13.186C15.6505 12.9117 16.0451 12.9117 16.1975 13.186L20.1368 20.2769C20.2849 20.5435 20.0922 20.8711 19.7872 20.8711H11.9084C11.6034 20.8711 11.4107 20.5435 11.5588 20.2769L15.4981 13.186Z" fill="currentColor" />
          <path d="M11.8603 11.3997C11.8603 12.286 11.1418 13.0045 10.2555 13.0045C9.36924 13.0045 8.65076 12.286 8.65076 11.3997C8.65076 10.5134 9.36924 9.79492 10.2555 9.79492C11.1418 9.79492 11.8603 10.5134 11.8603 11.3997Z" fill="currentColor" />
        </FileGlyph>
      );
    case 'markdown':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M8.7588 19.5V14.6H9.8998L11.9298 17.932H11.3278L13.3018 14.6H14.4428L14.4568 19.5H13.1828L13.1688 16.539H13.3858L11.9088 19.017H11.2928L9.7738 16.539H10.0398V19.5H8.7588ZM15.4375 19.5V14.6H17.7545C18.2958 14.6 18.7718 14.7003 19.1825 14.901C19.5932 15.1017 19.9128 15.384 20.1415 15.748C20.3748 16.112 20.4915 16.546 20.4915 17.05C20.4915 17.5493 20.3748 17.9833 20.1415 18.352C19.9128 18.716 19.5932 18.9983 19.1825 19.199C18.7718 19.3997 18.2958 19.5 17.7545 19.5H15.4375ZM16.8235 18.394H17.6985C17.9785 18.394 18.2212 18.3427 18.4265 18.24C18.6365 18.1327 18.7998 17.9787 18.9165 17.778C19.0332 17.5727 19.0915 17.33 19.0915 17.05C19.0915 16.7653 19.0332 16.5227 18.9165 16.322C18.7998 16.1213 18.6365 15.9697 18.4265 15.867C18.2212 15.7597 17.9785 15.706 17.6985 15.706H16.8235V18.394Z" fill="currentColor" />
        </FileGlyph>
      );
    case 'other': return <FileGlyph size={size} className={className} muted />;
    case 'pdf':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M6.80616 19.5V14.6H9.04616C9.49416 14.6 9.87916 14.6723 10.2012 14.817C10.5278 14.9617 10.7798 15.1717 10.9572 15.447C11.1345 15.7177 11.2232 16.0397 11.2232 16.413C11.2232 16.7817 11.1345 17.1013 10.9572 17.372C10.7798 17.6427 10.5278 17.8527 10.2012 18.002C9.87916 18.1467 9.49416 18.219 9.04616 18.219H7.57616L8.19216 17.617V19.5H6.80616ZM8.19216 17.764L7.57616 17.127H8.96216C9.2515 17.127 9.46616 17.064 9.60616 16.938C9.75083 16.812 9.82316 16.637 9.82316 16.413C9.82316 16.1843 9.75083 16.007 9.60616 15.881C9.46616 15.755 9.2515 15.692 8.96216 15.692H7.57616L8.19216 15.055V17.764ZM11.8989 19.5V14.6H14.2159C14.7573 14.6 15.2333 14.7003 15.6439 14.901C16.0546 15.1017 16.3743 15.384 16.6029 15.748C16.8363 16.112 16.9529 16.546 16.9529 17.05C16.9529 17.5493 16.8363 17.9833 16.6029 18.352C16.3743 18.716 16.0546 18.9983 15.6439 19.199C15.2333 19.3997 14.7573 19.5 14.2159 19.5H11.8989ZM13.2849 18.394H14.1599C14.4399 18.394 14.6826 18.3427 14.8879 18.24C15.0979 18.1327 15.2613 17.9787 15.3779 17.778C15.4946 17.5727 15.5529 17.33 15.5529 17.05C15.5529 16.7653 15.4946 16.5227 15.3779 16.322C15.2613 16.1213 15.0979 15.9697 14.8879 15.867C14.6826 15.7597 14.4399 15.706 14.1599 15.706H13.2849V18.394ZM17.6821 19.5V14.6H21.5251V15.671H19.0681V19.5H17.6821ZM18.9701 17.82V16.749H21.2311V17.82H18.9701Z" fill="currentColor" />
        </FileGlyph>
      );
    case 'ppt':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M11.0132 20.5V13.5H14.2132C14.8532 13.5 15.4032 13.6033 15.8632 13.81C16.3299 14.0167 16.6899 14.3167 16.9432 14.71C17.1966 15.0967 17.3232 15.5567 17.3232 16.09C17.3232 16.6167 17.1966 17.0733 16.9432 17.46C16.6899 17.8467 16.3299 18.1467 15.8632 18.36C15.4032 18.5667 14.8532 18.67 14.2132 18.67H12.1132L12.9932 17.81V20.5H11.0132ZM12.9932 18.02L12.1132 17.11H14.0932C14.5066 17.11 14.8132 17.02 15.0132 16.84C15.2199 16.66 15.3232 16.41 15.3232 16.09C15.3232 15.7633 15.2199 15.51 15.0132 15.33C14.8132 15.15 14.5066 15.06 14.0932 15.06H12.1132L12.9932 14.15V18.02Z" fill="currentColor" />
        </FileGlyph>
      );
    case 'video':
      return (
        <FileGlyph size={size} className={className} markTransform={FILE_MARK_TRANSFORM}>
          <path d="M17.5 14.634C18.1667 15.0189 18.1667 15.9811 17.5 16.366L11.5 19.8301C10.8333 20.215 10 19.7339 10 18.9641L10 12.0359C10 11.2661 10.8333 10.785 11.5 11.1699L17.5 14.634Z" fill="currentColor" />
        </FileGlyph>
      );
    case 'word':
      return (
        <FileGlyph size={size} className={className} markTransform={LARGE_FILE_MARK_TRANSFORM}>
          <path d="M10.5118 20.5L8.24179 13.5H10.2818L12.1918 19.56H11.1618L13.1718 13.5H14.9918L16.8918 19.56H15.9018L17.8718 13.5H19.7618L17.4918 20.5H15.3718L13.7518 15.35H14.3218L12.6318 20.5H10.5118Z" fill="currentColor" />
        </FileGlyph>
      );
  }
}

/** 文件类型图标入口：代码类走全彩方章，传统类走页身 glyph（配色由 style.css 的类型类决定）。 */
export function FileTypeIcon({ path, size = 16, className }: IconProps & { readonly path: string }): ReactNode {
  const type = classifyFileType(path);
  if (isCodeFileType(type)) {
    return <span className={`wf-ft wf-ft-code-brand ${className ?? ''}`}><CodeFileIcon type={type} size={size} /></span>;
  }
  return <span className={`wf-ft wf-ft-${type} ${className ?? ''}`}>{traditionalGlyph(type, size, undefined)}</span>;
}

/* ---- 文档缩放档位按钮图标（放大镜 ±，currentColor 线性图标） ---- */

export function ZoomInIcon({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="6.75" cy="6.75" r="4.25" stroke="currentColor"></circle>
      <path d="M10 10L13.5 13.5" stroke="currentColor" strokeLinecap="round"></path>
      <path d="M4.75 6.75H8.75M6.75 4.75V8.75" stroke="currentColor" strokeLinecap="round"></path>
    </svg>
  );
}

export function ZoomOutIcon({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <circle cx="6.75" cy="6.75" r="4.25" stroke="currentColor"></circle>
      <path d="M10 10L13.5 13.5" stroke="currentColor" strokeLinecap="round"></path>
      <path d="M4.75 6.75H8.75" stroke="currentColor" strokeLinecap="round"></path>
    </svg>
  );
}

/* ---- 文件树目录图标（照搬 DSH icons/artwork.ts 的 folder-open / folder-close，currentColor） ---- */

export function FolderOpenIcon({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z" fill="currentColor" opacity="0.16"></path>
      <path d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z" fill="currentColor"></path>
      <path d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z" fill="currentColor"></path>
    </svg>
  );
}

export function FolderCloseIcon({ size = 16, className }: IconProps): ReactNode {
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" stroke="currentColor"></path>
      <path d="M3.63501 7.66614H12.3647" stroke="currentColor"></path>
    </svg>
  );
}
