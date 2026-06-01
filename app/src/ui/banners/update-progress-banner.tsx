import * as React from 'react'

import { Banner } from './banner'
import { Octicon } from '../octicons'
import * as octicons from '../octicons/octicons.generated'

interface IUpdateProgressBannerProps {
  /** Download progress of the pending update, 0-100. */
  readonly progress: number

  readonly onDismissed: () => void
}

/**
 * Banner shown while a custom update is being downloaded. Renders a live
 * progress bar and percentage instead of static text.
 */
export class UpdateProgressBanner extends React.Component<
  IUpdateProgressBannerProps,
  {}
> {
  public render() {
    const progress = Math.max(
      0,
      Math.min(100, Math.round(this.props.progress))
    )

    return (
      <Banner
        id="update-progress-banner"
        dismissable={false}
        onDismissed={this.props.onDismissed}
      >
        <Octicon className="download-icon" symbol={octicons.desktopDownload} />
        <span className="update-progress-text">
          Downloading update… {progress}%
        </span>
        <progress
          className="update-progress-bar"
          value={progress}
          max={100}
        />
      </Banner>
    )
  }
}
