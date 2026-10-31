import type { ComponentOverride } from '@open-mercato/shared/modules/widgets/component-registry'
import { withLoginAvailability } from '../components/LoginAvailability'

export const componentOverrides: ComponentOverride[] = [
  {
    target: { componentId: 'section:auth.login.form' },
    priority: 50,
    metadata: { module: 'foundation_ui' },
    wrapper: (Original) => withLoginAvailability(Original),
  },
]

export default componentOverrides
